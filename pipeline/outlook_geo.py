"""Build the fixed geography of the outlook, from the files zone_capacity.py downloads to data/raw/zones.

  pipeline/nl_cells.json  the 0.25 degree cells of each Dutch PECD zone with their mask weight; grid.py
                          averages ERA5 and HARMONIE over them, the way PECD averages ERA5 over its zones
  pipeline/farms.json     offshore wind farms on the outlook's wind map (Open European offshore wind
                          turbine database), one point per farm with its capacity
"""

import json
from pathlib import Path

import pandas as pd
import xarray as xr

from harmonie import FIELD_LAT, FIELD_LON
from zone_capacity import WORK

CELLS = Path(__file__).with_name("nl_cells.json")
FARMS = Path(__file__).with_name("farms.json")


def cells() -> None:
    out = {}
    for name in ("PEON", "PEOF"):
        masks = xr.open_dataset(WORK / f"ANCI_{name}-mask_PECD4.2_fv1.nc").mask
        for region in masks.region.values:
            if not str(region).startswith("NL"):
                continue
            m = masks.sel(region=region)
            m = m.where(m > 0, drop=True).stack(cell=("latitude", "longitude")).dropna("cell")
            out[str(region)] = [[float(la), float(lo), round(float(w), 4)] for (la, lo), w in zip(m.cell.values, m.values)]
    CELLS.write_text(json.dumps(out, separators=(",", ":")))
    print("cells", {z: len(c) for z, c in out.items()})


def farms() -> None:
    t = pd.read_csv(WORK / "offshore.csv", index_col=0)
    t = t[t.latitude.between(FIELD_LAT[0], FIELD_LAT[-1]) & t.longitude.between(FIELD_LON[0], FIELD_LON[-1])]
    g = t.groupby("wind_farm").agg(lat=("latitude", "mean"), lon=("longitude", "mean"), mw=("rated_power", "sum"),
                                   cc=("country", "first"), since=("commissioning_date", "min"))
    out = [{"name": n, "lat": round(r.lat, 3), "lon": round(r.lon, 3), "mw": round(r.mw), "nl": r.cc == "Netherlands",
            "since": str(r.since)[:4]} for n, r in g.sort_values("mw", ascending=False).iterrows()]
    FARMS.write_text(json.dumps(out, separators=(",", ":")))
    print("farms", len(out), "NL", sum(f["nl"] for f in out))


if __name__ == "__main__":
    cells()
    farms()
