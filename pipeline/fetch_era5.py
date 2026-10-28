"""Download the ERA5 weather that the outlook's transfer functions are fitted on (calibrate.py).

Hourly 100 m wind and surface solar radiation for TRAIN, from the ERA5 point time series: one request per
0.25 degree cell of the Dutch zones with turbines, into data/raw/era5/train/<lat>_<lon>.csv. Existing cells
are skipped. The point series are served quickly; the regular gridded ERA5 queue can take hours.

CDS limits queued requests per user, so this runs two at a time and, when the queue is full, waits for a slot.
"""

import os
import random
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cdsapi

from grid import cells
from process import zone_capacity

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "era5" / "train"
DATASET = "reanalysis-era5-single-levels-timeseries"
VARIABLES = ["100m_u_component_of_wind", "100m_v_component_of_wind", "surface_solar_radiation_downwards"]
TRAIN = list(range(2016, 2026))


def jobs() -> list[tuple[Path, dict]]:
    capacity = {z for zones in zone_capacity().values() for z in zones if z.startswith("NL")}
    points = sorted({(la, lo) for z, cs in cells().items() if z in capacity for la, lo, _ in cs})
    return [
        (OUT / f"{la:.2f}_{lo:.2f}.csv", {
            "variable": VARIABLES, "location": {"latitude": la, "longitude": lo},
            "date": [f"{min(TRAIN)}-01-01/{max(TRAIN)}-12-31"], "data_format": "csv",
        })
        for la, lo in points if not (OUT / f"{la:.2f}_{lo:.2f}.csv").exists()
    ]


def fetch(client: cdsapi.Client, target: Path, req: dict) -> str:
    """One cell; the answer is a zip with one CSV, which is unpacked."""
    part = target.with_suffix(".part")
    for _ in range(120):
        try:
            client.retrieve(DATASET, req).download(str(part))
            break
        except Exception as exc:
            if "queued requests" not in str(exc):
                raise
            time.sleep(random.uniform(30, 90))  # staggered, so waiting requests do not collide again
    else:
        raise RuntimeError(f"{target.name}: no free queue slot at CDS after two hours")
    with zipfile.ZipFile(part) as z:
        target.write_bytes(z.read(z.namelist()[0]))
    os.remove(part)
    return f"done  {target.name}"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    client = cdsapi.Client(quiet=True, progress=False)
    failed = 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(fetch, client, t, r): t.name for t, r in jobs()}
        for future in as_completed(futures):
            try:
                print(future.result(), flush=True)
            except Exception as exc:
                failed += 1
                print(f"FAIL  {futures[future]}: {exc}", flush=True)
                if "403" in str(exc):  # account or licence problem: stop instead of hammering the API
                    pool.shutdown(cancel_futures=True)
                    break
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
