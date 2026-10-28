"""Average weather grids over the Dutch PECD zones, the way PECD averages ERA5 over its zones.

Each zone is a set of 0.25 degree cells with a mask weight (pipeline/nl_cells.json, built by outlook_geo.py).
Grid points are assigned to the cell they fall in, so a fine grid (HARMONIE, 2 km) is first averaged per
cell and then over the zone, like the coarse ERA5 grid. Solar radiation is averaged over the onshore zones
together, which stand for the Dutch land area.
"""

import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

CELLS = Path(__file__).with_name("nl_cells.json")
LAND = ["NL01", "NL02", "NL03", "NL04"]


def cells() -> dict[str, list]:
    return json.loads(CELLS.read_text())


def zone_means(lat: np.ndarray, lon: np.ndarray, field: np.ndarray, zones: dict[str, list]) -> dict[str, np.ndarray]:
    """Mask-weighted mean of field (time, lat, lon) over each zone; cells without a value are left out."""
    clat = np.round(np.asarray(lat) * 4) / 4
    clon = np.round(np.asarray(lon) * 4) / 4
    out = {}
    warnings.filterwarnings("ignore", "Mean of empty slice", RuntimeWarning)  # hours without a value stay NaN
    for zone, zc in zones.items():
        num = np.zeros(field.shape[0])
        den = np.zeros(field.shape[0])
        for la, lo, w in zc:
            rows = np.flatnonzero(clat == la)
            cols = np.flatnonzero(clon == lo)
            if len(rows) and len(cols):
                cell = np.nanmean(field[:, rows][:, :, cols], axis=(1, 2))
                ok = ~np.isnan(cell)
                num[ok] += w * cell[ok]
                den[ok] += w
        if den.any():
            out[zone] = np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)
    return out


def weather(times, lat, lon, ws: np.ndarray, ssrd: np.ndarray) -> pd.DataFrame:
    """Hourly table: 100 m wind speed per zone (m/s) and mean radiation over land (ssrd, W/m2)."""
    zones = cells()
    df = pd.DataFrame(zone_means(lat, lon, ws, zones), index=pd.DatetimeIndex(times, name="time"))
    land = {"land": [c for z in LAND for c in zones[z]]}
    df["ssrd"] = zone_means(lat, lon, ssrd, land)["land"]
    return df.astype("float32")


def era5_points(paths: list[Path]) -> pd.DataFrame:
    """Weather table from ERA5 point time series (one CSV per 0.25 degree cell, fetch_era5.py --train).

    The cells are put back on a grid, with NaN where no cell was fetched, so the zones average them exactly
    like the gridded ERA5.
    """
    points = {}
    for path in paths:
        df = pd.read_csv(path, index_col="valid_time", parse_dates=True)
        points[(float(df["latitude"].iloc[0]), float(df["longitude"].iloc[0]))] = df
    lats = sorted({la for la, _ in points})
    lons = sorted({lo for _, lo in points})
    times = next(iter(points.values())).index
    ws = np.full((len(times), len(lats), len(lons)), np.nan, dtype="float32")
    ssrd = np.full_like(ws, np.nan)
    for (la, lo), df in points.items():
        i, j = lats.index(la), lons.index(lo)
        df = df.reindex(times)
        ws[:, i, j] = np.hypot(df["u100"], df["v100"])
        ssrd[:, i, j] = df["ssrd"] / 3600
    return weather(times, np.array(lats), np.array(lons), ws, ssrd)
