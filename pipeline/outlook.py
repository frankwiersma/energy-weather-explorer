"""Build the Dutch wind and solar outlook: the last weeks plus the next 60 hours, on the PECD scale.

Sources, joined end to end on one hourly axis:
  pecd       capacity factors as published, up to PECD's last month
  harmonie   the start of each earlier HARMONIE run, for the weeks since then
  forecast   the newest HARMONIE run, 60 hours ahead

HARMONIE's weather is averaged over the PECD zones (grid.py), scaled to match PECD and turned into capacity
factors with the transfer functions fitted on ERA5 against PECD (calibrate.py, transfer.py).
National values use the app's capacity weights. The output also carries the 1991-2020 normal range for
each hour and the HARMONIE 100 m wind field for the map.

Writes data/outlook/NL.json and data/outlook/wind.bin.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from harmonie import OUT as HARMONIE
from transfer import debias, load, to_cf

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public" / "data"
OUT = ROOT / "data" / "outlook"
HISTORY_DAYS = 28
NORMAL_YEARS = range(1991, 2021)
NORMAL_WINDOW = 10  # days either side of the date
WIND_SCALE = 0.5  # m/s per step in wind.bin
TECHS = ["won", "wof", "spv"]


def mean_wind(weather: pd.DataFrame, tf: dict, tech: str) -> pd.Series:
    """Capacity-weighted 100 m wind speed over a technology's zones, for the tooltips."""
    zones = tf[tech]
    return sum(weather[z] * v["mw"] for z, v in zones.items()) / sum(v["mw"] for v in zones.values())


def pecd(since: pd.Timestamp) -> pd.DataFrame:
    frames = []
    for year in range(since.year, datetime.now(timezone.utc).year + 1):
        path = PUBLIC / "hourly" / "NL" / f"{year}.json"
        if path.exists():
            d = json.loads(path.read_text())
            idx = pd.date_range(d["start"], periods=len(d["won"]), freq="h")
            frames.append(pd.DataFrame({t: np.array(d[t], dtype="float64") / 1000 for t in TECHS}, index=idx))
    df = pd.concat(frames)
    return df[df.index >= since]


def harmonie_runs() -> list[tuple[pd.Timestamp, pd.DataFrame]]:
    runs = []
    for path in sorted(HARMONIE.glob("*.csv")):
        df = pd.read_csv(path, index_col="time", parse_dates=True)
        runs.append((pd.Timestamp(datetime.strptime(path.stem, "%Y%m%d%H%M")), df))
    return runs


def harmonie_chain(runs, after: pd.Timestamp) -> pd.DataFrame:
    """Each earlier run from lead 1 up to the start of the next run, for the hours after `after`."""
    parts = []
    for (start, df), (nxt, _) in zip(runs, runs[1:]):
        parts.append(df[(df["lead"] >= 1) & (df.index <= nxt)])
    chain = pd.concat(parts) if parts else pd.DataFrame()
    chain = chain[~chain.index.duplicated(keep="last")]
    return chain[chain.index > after].drop(columns="lead")


def normals(axis: pd.DatetimeIndex, gw: dict) -> dict:
    """10th, 50th and 90th percentile per hour of the axis, from the same hour within +-10 days in 1991-2020."""
    years = []
    for y in NORMAL_YEARS:
        d = json.loads((PUBLIC / "hourly" / "NL" / f"{y}.json").read_text())
        arr = {t: np.array(d[t], dtype="float64") / 1000 for t in TECHS}
        if y % 4 == 0:  # drop 29 February
            arr = {t: np.delete(a, np.s_[59 * 24:60 * 24]) for t, a in arr.items()}
        years.append({t: a[: 365 * 24] for t, a in arr.items()})
    stack = {t: np.stack([a[t] for a in years]).reshape(len(years), 365, 24) for t in TECHS}
    total = sum(gw.values())
    stack["mix"] = sum(stack[t] * gw.get(t, 0) for t in TECHS) / total
    out = {k: {"p10": [], "p50": [], "p90": []} for k in stack}
    for ts in axis:
        doy = min(ts.dayofyear - (1 if ts.is_leap_year and ts.month > 2 else 0), 365) - 1
        days = (np.arange(doy - NORMAL_WINDOW, doy + NORMAL_WINDOW + 1)) % 365
        for k, s in stack.items():
            p10, p50, p90 = np.nanpercentile(s[:, days, ts.hour], [10, 50, 90])
            out[k]["p10"].append(int(round(p10 * 1000)))
            out[k]["p50"].append(int(round(p50 * 1000)))
            out[k]["p90"].append(int(round(p90 * 1000)))
    return out


def ints(values, factor: float) -> list:
    return [None if pd.isna(v) else int(round(v * factor)) for v in values]


def wind_field(run_stem: str) -> dict:
    """The newest run's 100 m wind as int8 steps of WIND_SCALE m/s, frame by frame: u then v."""
    f = np.load(HARMONIE / f"{run_stem}_field.npz")
    u = np.clip(np.round(f["u"].astype("float32") / WIND_SCALE), -127, 127).astype("int8")
    v = np.clip(np.round(f["v"].astype("float32") / WIND_SCALE), -127, 127).astype("int8")
    (OUT / "wind.bin").write_bytes(np.stack([u, v], axis=1).tobytes())
    lat, lon = f["lat"], f["lon"]
    return {
        "file": "wind.bin", "frames": int(u.shape[0]), "scale": WIND_SCALE,
        "lat0": float(lat[0]), "dlat": round(float(lat[1] - lat[0]), 3), "nlat": int(len(lat)),
        "lon0": float(lon[0]), "dlon": round(float(lon[1] - lon[0]), 3), "nlon": int(len(lon)),
    }


def farms() -> list:
    return json.loads(Path(__file__).with_name("farms.json").read_text())


def main() -> None:
    tf = load()
    meta = json.loads((PUBLIC / "meta.json").read_text())
    gw = meta["weights"]["NL"]["gw"]
    runs = harmonie_runs()
    if not runs:
        raise SystemExit("No HARMONIE runs in data/raw/harmonie; run harmonie.py first")
    run_start, newest = runs[-1]
    now = pd.Timestamp(datetime.now(timezone.utc).replace(tzinfo=None)).floor("h")
    start = (now - pd.Timedelta(days=HISTORY_DAYS)).floor("D")

    published = pecd(start)
    chain = debias(harmonie_chain(runs, published.index.max()), tf)
    covered = chain.index.max() if len(chain) else published.index.max()
    forecast = debias(newest[newest["lead"] >= 1].drop(columns="lead"), tf)
    forecast = forecast[forecast.index > covered]

    weather = pd.concat([chain, forecast])
    modelled = to_cf(weather, tf)
    cf = pd.concat([published[TECHS], modelled]).sort_index()
    cf = cf[~cf.index.duplicated(keep="first")]
    axis = pd.date_range(start, forecast.index.max(), freq="h")
    cf = cf.reindex(axis).interpolate(limit=1, limit_area="inside")  # the single hour where two sources meet
    total = sum(gw.values())
    cf["mix"] = sum(cf[t] * gw.get(t, 0) for t in TECHS) / total

    def index_of(ts):
        return int(axis.get_indexer([ts], method="nearest")[0])

    segments = [
        ("pecd", published.index.min() if len(published) else None, published.index.max() if len(published) else None),
        ("harmonie", chain.index.min() if len(chain) else None, chain.index.max() if len(chain) else None),
        ("forecast", forecast.index.min(), forecast.index.max()),
    ]
    ws = weather.reindex(axis)
    OUT.mkdir(parents=True, exist_ok=True)
    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "start": axis[0].strftime("%Y-%m-%dT%H:00Z"),
        "hours": len(axis),
        "now": index_of(now),
        "run": run_start.strftime("%Y-%m-%dT%H:00Z"),
        "segments": [{"source": s, "from": index_of(a), "to": index_of(b)} for s, a, b in segments if a is not None and a >= axis[0]],
        "gw": gw,
        "cf": {k: ints(cf[k], 1000) for k in TECHS + ["mix"]},
        "ws": {t: ints(mean_wind(ws, tf, t), 10) for t in ("won", "wof")},
        "normal": normals(axis, gw),
        "skill": {
            "holdout": tf["holdout"],
            **{t: {z: v["test"] for z, v in tf[t].items()} for t in ("won", "wof")},
            "spv": tf["spv"]["test"],
            "harmonie": (tf.get("harmonie") or {}).get("fit", {}).get("national"),
        },
        "field": {**wind_field(run_start.strftime("%Y%m%d%H%M")), "start": run_start.strftime("%Y-%m-%dT%H:00Z")},
        "farms": farms(),
    }
    (OUT / "NL.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT / 'NL.json'}: {len(axis)} hours, run {out['run']}, segments {out['segments']}")


if __name__ == "__main__":
    main()
