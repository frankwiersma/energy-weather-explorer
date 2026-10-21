"""Turn the PECD zips in data/raw into the compact JSON files the web app reads (public/data).

Outputs:
  meta.json              countries, coverage, default capacity weights
  country/<CC>.json      daily series 1950 onwards for one country
  daily/<YYYY>.json      daily values for all countries in one year (map view)
  hourly/<CC>/<YYYY>.json  hourly capacity factors for the countries in HOURLY

Values are stored as integers: capacity factor x1000, temperature in 0.1 degC.
"""

import io
import json
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "data"
GEO_SOURCE = ROOT / "data" / "geo" / "NUTS_RG_20M_2021_4326_LEVL_0.geojson"
VARS = ["spv", "won", "wof", "t2m"]
CF_VARS = ["spv", "won", "wof"]
HOURLY = ["NL", "DE"]

# Installed capacity at the end of 2024, used as the default wind/solar mix in the app.
WEIGHTS = {
    "NL": {
        "gw": {"spv": 28.6, "won": 7.0, "wof": 4.7},
        "note": "Defaults: installed capacity end 2024 (CBS solar 28.6 GWp, RVO onshore 7.0 GW, offshore 4.7 GW).",
    },
    "DE": {
        "gw": {"spv": 99.3, "won": 63.5, "wof": 9.2},
        "note": "Defaults: installed capacity end 2024 (Bundesnetzagentur: solar 99.3 GW, onshore 63.5 GW, offshore 9.2 GW).",
    },
}


def read_zip(path: Path) -> list[pd.DataFrame]:
    frames = []
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if n.endswith(".csv")):
            with z.open(name) as f:
                df = pd.read_csv(io.TextIOWrapper(f, "utf-8"), comment="#", index_col=0, parse_dates=True)
            frames.append(df.astype("float32"))
    return frames


ZONE_PREFIX = {"GR": "EL"}  # PECD wind zones use ISO GR, NUTS uses EL


def to_country(df: pd.DataFrame) -> pd.DataFrame:
    """Columns are countries (NUTS 0) or PECD zones whose code starts with the country code; average per country."""
    return df.T.groupby(lambda c: ZONE_PREFIX.get(c[:2], c[:2])).mean().T


def load_var(key: str) -> pd.DataFrame:
    frames = [f for z in sorted((RAW / key).glob("*.zip")) for f in read_zip(z)]
    if not frames:
        raise SystemExit(f"No data for {key} in {RAW / key}")
    # Files are read in name order, so a later file wins where periods overlap.
    df = pd.concat([to_country(f) for f in frames]).sort_index(kind="stable")
    df = df[~df.index.duplicated(keep="last")]
    if key == "t2m" and df.stack().median() > 100:
        df = df - 273.15
    return df


def ints(series: pd.Series, factor: float) -> list:
    return [None if pd.isna(v) else int(round(v * factor)) for v in series.to_numpy()]


def europe_geojson() -> dict:
    """NUTS 0 outlines (Eurostat GISCO) without polygons outside the PECD map window (Svalbard, overseas regions)."""
    geo = json.loads(GEO_SOURCE.read_text())

    def inside(ring):
        lon = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        return -25 <= lon <= 45 and 34 <= lat <= 72

    for f in geo["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        g["type"], g["coordinates"] = "MultiPolygon", [poly for poly in polys if inside(poly[0])]
    return geo


def centroids(geo: dict) -> dict:
    """Centre (lon, lat) of each country's largest polygon, for distances between countries."""
    out = {}
    for f in geo["features"]:
        rings = [poly[0] for poly in f["geometry"]["coordinates"]]
        if not rings:
            continue
        ring = max(rings, key=len)
        out[f["properties"]["NUTS_ID"]] = [
            round(sum(p[0] for p in ring) / len(ring), 2),
            round(sum(p[1] for p in ring) / len(ring), 2),
        ]
    return out


def write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))


def main() -> None:
    geo = europe_geojson()
    write(OUT / "europe.geojson", geo)
    names = {f["properties"]["NUTS_ID"]: f["properties"]["NAME_LATN"] for f in geo["features"]}
    names.update({"UK": "United Kingdom", "EL": "Greece", "DE": "Germany", "NL": "Netherlands"})

    hourly = {k: load_var(k) for k in VARS}
    for k, df in hourly.items():
        print(f"{k}: {df.index.min()} .. {df.index.max()}, {len(df.columns)} countries")
    countries = sorted(set(hourly["spv"].columns) & set(names))
    daily = {k: df.resample("D").mean() for k, df in hourly.items()}
    start = min(d.index.min() for d in daily.values()).normalize()
    end = max(d.index.max() for d in daily.values()).normalize()
    days = pd.date_range(start, end, freq="D")
    daily = {k: d.reindex(days) for k, d in daily.items()}
    factor = {k: (10 if k == "t2m" else 1000) for k in VARS}

    for cc in countries:
        obj = {"start": str(start.date())}
        for k in VARS:
            obj[k] = ints(daily[k][cc], factor[k]) if cc in daily[k] and daily[k][cc].notna().any() else None
        write(OUT / "country" / f"{cc}.json", obj)

    for year in range(start.year, end.year + 1):
        sel = (days.year == year)
        obj = {"start": f"{year}-01-01", "days": int(sel.sum())}
        for k in VARS:
            obj[k] = {
                cc: ints(daily[k].loc[sel, cc], factor[k])
                for cc in countries
                if cc in daily[k] and daily[k].loc[sel, cc].notna().any()
            }
        write(OUT / "daily" / f"{year}.json", obj)

    for cc in HOURLY:
        for year in range(start.year, end.year + 1):
            obj = {"start": f"{year}-01-01T00:00:00"}
            for k in CF_VARS:
                s = hourly[k].loc[str(year), cc] if cc in hourly[k] else None
                obj[k] = ints(s, 1000) if s is not None else None
            write(OUT / "hourly" / cc / f"{year}.json", obj)

    # Daily wind capacity factor per country (mean of onshore and offshore where both exist), for pooling.
    wind = pd.concat([daily["won"], daily["wof"]]).groupby(level=0).mean().reindex(days)
    write(
        OUT / "wind.json",
        {"start": str(start.date()), "countries": {cc: ints(wind[cc], 1000) for cc in countries if cc in wind}},
    )

    # Last day for which every capacity factor variable has data.
    last = min(daily[k].dropna(how="all").index.max() for k in CF_VARS)
    # The projections block is written by process_projections.py and survives a rerun of this script.
    old_meta = json.loads((OUT / "meta.json").read_text()) if (OUT / "meta.json").exists() else {}
    write(
        OUT / "meta.json",
        {
            **({"projections": old_meta["projections"]} if "projections" in old_meta else {}),
            "firstYear": start.year,
            "lastYear": end.year,
            "lastDate": str(last.date()),
            "generated": str(date.today()),
            "countries": {cc: names[cc] for cc in countries},
            "centroids": {cc: c for cc, c in centroids(geo).items() if cc in countries},
            "hourly": HOURLY,
            "weights": WEIGHTS,
        },
    )
    print(f"{len(countries)} countries, {start.date()} .. {last.date()}")


if __name__ == "__main__":
    main()
