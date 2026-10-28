"""Download the newest HARMONIE-AROME Cy43 P1 run from the KNMI Data Platform and keep what the outlook needs.

KNMI publishes a deterministic run every hour, 60 hours ahead on a 2 km lat-lon grid over the Netherlands
and the North Sea, as one tar of GRIB1 files per run (one file per lead hour). The tar is streamed and only
three fields are kept: the wind at 100 m (u, v) and the global radiation, accumulated since the start of
the run. Per run this writes data/raw/harmonie/<run>.csv (100 m wind speed per PECD zone and hourly
radiation over land, per lead hour) and <run>_field.npz (the 100 m wind on a coarse grid for the map).

Besides the newest run it fetches the runs that are missing between PECD's end and now (see missing()), and
drops older tables. With --sample DAYS it fetches archived runs since January into data/raw/harmonie/sample
instead, which calibrate.py compares with PECD. Needs KNMI_API_KEY (a registered Open Data API key from developer.dataplatform.knmi.nl).
"""

import argparse
import json
import os
import re
import sys
import tarfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import eccodes
import numpy as np
import pandas as pd
import requests

from grid import weather

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "harmonie"
API = "https://api.dataplatform.knmi.nl/open-data/v1/datasets/harmonie_arome_cy43_p1/versions/1.0/files"
MEMBER = re.compile(r"HA43_N20_(\d{12})_(\d{3})(\d{2})_GB")
# indicatorOfParameter, indicatorOfTypeOfLevel 105 (height above ground), level
FIELDS = {(33, 100): "u", (34, 100): "v", (117, 0): "grad"}
ARCHIVE_START = datetime(2026, 1, 9)  # KNMI keeps P1 runs from 8 January 2026
# The wind map: 0.1 degree over the Netherlands, Belgium and the southern North Sea.
FIELD_LAT = np.round(np.arange(50.5, 55.81, 0.1), 2)
FIELD_LON = np.round(np.arange(1.5, 8.51, 0.1), 2)


def session() -> requests.Session:
    key = os.environ.get("KNMI_API_KEY")
    if not key:
        raise SystemExit("Set KNMI_API_KEY to a registered KNMI Open Data API key")
    s = requests.Session()
    s.headers["Authorization"] = key
    return s


def newest(s: requests.Session) -> str:
    r = s.get(API, params={"maxKeys": 1, "orderBy": "created", "sorting": "desc"}, timeout=30)
    r.raise_for_status()
    return r.json()["files"][0]["filename"]


def fields(message: bytes) -> tuple[str, dict] | None:
    gid = eccodes.codes_new_from_message(message)
    try:
        key = (eccodes.codes_get(gid, "indicatorOfParameter"), eccodes.codes_get(gid, "level"))
        if eccodes.codes_get(gid, "indicatorOfTypeOfLevel", ktype=int) != 105 or key not in FIELDS:
            return None
        ni, nj = eccodes.codes_get(gid, "Ni"), eccodes.codes_get(gid, "Nj")
        grid = {k: eccodes.codes_get(gid, k) for k in (
            "latitudeOfFirstGridPointInDegrees", "longitudeOfFirstGridPointInDegrees",
            "latitudeOfLastGridPointInDegrees", "longitudeOfLastGridPointInDegrees")}
        values = eccodes.codes_get_values(gid).reshape(nj, ni).astype("float32")
        return FIELDS[key], {"values": values, **grid}
    finally:
        eccodes.codes_release(gid)


def grib_messages(data: bytes):
    """A HARMONIE file is several GRIB messages back to back."""
    start = 0
    while (start := data.find(b"GRIB", start)) >= 0:
        length = int.from_bytes(data[start + 4:start + 7], "big")
        yield data[start:start + length]
        start += length


class NotInArchive(Exception):
    pass


def download_url(s: requests.Session, filename: str) -> str:
    """A temporary download link for one run; the API answers the odd request with a transient error."""
    for attempt in range(4):
        r = s.get(f"{API}/{filename}/url", timeout=30)
        if r.ok:
            return r.json()["temporaryDownloadUrl"]
        if r.status_code == 404:
            raise NotInArchive(filename)
        time.sleep(10 * (attempt + 1))
    raise SystemExit(f"No download link for {filename}: {r.status_code} {r.text[:200]}")


def fetch(s: requests.Session, filename: str) -> tuple[str, dict]:
    """Stream one run and return its run time and the u, v, grad stacks (lead, lat, lon) with the grid axes."""
    url = download_url(s, filename)
    lead_fields: dict[int, dict] = {}
    grid = None
    run = None
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with tarfile.open(fileobj=r.raw, mode="r|*") as tar:
            for member in tar:
                m = MEMBER.search(member.name)
                if not m or not member.isfile():
                    continue
                run, lead = m.group(1), int(m.group(2))
                for message in grib_messages(tar.extractfile(member).read()):
                    got = fields(message)
                    if got:
                        name, f = got
                        lead_fields.setdefault(lead, {})[name] = f.pop("values")
                        grid = grid or f
    if not lead_fields:
        raise SystemExit(f"No HARMONIE fields found in {filename}")
    leads = sorted(lead_fields)
    nj, ni = lead_fields[leads[0]]["u"].shape
    data = {k: np.stack([lead_fields[l][k] for l in leads]) for k in ("u", "v", "grad")}
    data["leads"] = np.array(leads)
    data["lat"] = np.linspace(grid["latitudeOfFirstGridPointInDegrees"], grid["latitudeOfLastGridPointInDegrees"], nj)
    data["lon"] = np.linspace(grid["longitudeOfFirstGridPointInDegrees"], grid["longitudeOfLastGridPointInDegrees"], ni)
    return run, data


def reduce(run: str, data: dict) -> tuple[pd.DataFrame, dict]:
    """Zone wind speeds and land radiation per lead hour, and the wind field on a 0.1 degree grid for the map.

    Global radiation is accumulated since the start of the run; the hourly mean in W/m2 is the difference
    between lead hours. Lead 0 has no radiation value.
    """
    start = datetime.strptime(run, "%Y%m%d%H%M")
    times = [start + timedelta(hours=int(l)) for l in data["leads"]]
    ws = np.hypot(data["u"], data["v"])
    ssrd = np.diff(data["grad"], axis=0, prepend=np.nan) / 3600
    table = weather(times, data["lat"], data["lon"], ws, ssrd)
    table.insert(0, "lead", data["leads"])
    rows = np.abs(data["lat"][:, None] - FIELD_LAT).argmin(axis=0)
    cols = np.abs(data["lon"][:, None] - FIELD_LON).argmin(axis=0)
    field = {
        "lat": FIELD_LAT, "lon": FIELD_LON,
        "u": data["u"][:, rows][:, :, cols].astype("float16"),
        "v": data["v"][:, rows][:, :, cols].astype("float16"),
    }
    return table, field


def pecd_end() -> datetime:
    return datetime.fromisoformat(json.loads((ROOT / "public" / "data" / "meta.json").read_text())["lastDate"]) + timedelta(days=1)


def missing() -> list[str]:
    """Runs not stored yet that cover PECD's end up to now, oldest first: the 00 UTC run of each day, and
    the 00, 06, 12 and 18 UTC runs of the last week (outlook.py chains them)."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    recent = now - timedelta(days=7)
    have = {p.stem for p in OUT.glob("*.csv")}
    out = []
    slot = pecd_end()
    while slot <= now - timedelta(hours=3):
        if (slot >= recent or slot.hour == 0) and slot.strftime("%Y%m%d%H%M") not in have:
            out.append(slot.strftime("%Y%m%d%H"))
        slot += timedelta(hours=6)
    return out


def sample(step: int) -> list[str]:
    """The 00 UTC run every `step` days from the start of the archive up to PECD's end, for calibrate.py."""
    have = {p.stem for p in (OUT / "sample").glob("*.csv")}
    day, end, out = ARCHIVE_START, pecd_end() - timedelta(days=3), []
    while day <= end:
        if day.strftime("%Y%m%d%H%M") not in have:
            out.append(day.strftime("%Y%m%d%H"))
        day += timedelta(days=step)
    return out


def prune() -> None:
    """Drop run tables from before PECD's end and keep the wind field of the newest run only."""
    cutoff = (pecd_end() - timedelta(days=3)).strftime("%Y%m%d%H%M")
    for p in OUT.glob("*.csv"):
        if p.stem < cutoff:
            p.unlink()
    for p in sorted(OUT.glob("*_field.npz"))[:-1]:
        p.unlink()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--runs", nargs="*", help="run times as YYYYMMDDHH instead of the missing and newest runs")
    p.add_argument("--sample", type=int, metavar="DAYS", help="fetch the 00 UTC run every DAYS days since January for calibration")
    args = p.parse_args()
    s = session()
    target = OUT / "sample" if args.sample else OUT
    target.mkdir(parents=True, exist_ok=True)
    if args.sample:
        runs = sample(args.sample)
    else:
        runs = args.runs or [*missing(), newest(s)[len("HARM43_V1_P1_"):-len(".tar")]]
    for r in dict.fromkeys(runs):
        try:
            run, data = fetch(s, f"HARM43_V1_P1_{r}.tar")
        except NotInArchive:
            print(f"skip  {r}: not in the KNMI archive", flush=True)
            continue
        table, field = reduce(run, data)
        table.to_csv(target / f"{run}.csv", float_format="%.3f")
        if not args.sample:
            np.savez_compressed(OUT / f"{run}_field.npz", **field)
        print(f"done  {run}", flush=True)
    if not args.sample:
        prune()
    sys.exit(0)


if __name__ == "__main__":
    main()
