"""Turn the PECD zips in data/raw into the compact JSON files the web app reads (public/data).

Outputs:
  meta.json              countries, coverage, default capacity weights
  country/<CC>.json      daily series 1950 onwards for one country
  daily/<YYYY>.json      daily values for all countries in one year (map view)
  hourly/<CC>/<YYYY>.json  hourly capacity factors for the countries in HOURLY
  zones/<CC>.json        daily wind per PECD zone with its capacity share (countries with several zones)
  wind.json              daily wind capacity factor of each national fleet, and its capacity

Wind arrives per PECD zone and is weighted by installed capacity per zone (pipeline/zone_capacity.csv).

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

# Default wind/solar mix in the app: the actual fleet at the end of 2024 where national statistics are
# at hand, otherwise ENTSO-E ERAA 2025 capacities for 2028 (pipeline/national_capacity.csv).
ACTUAL = {
    "NL": ({"spv": 28.6, "won": 7.0, "wof": 4.7}, "installed capacity end 2024 (CBS solar 28.6 GWp, RVO onshore 7.0 GW, offshore 4.7 GW)"),
    "DE": ({"spv": 99.3, "won": 63.5, "wof": 9.2}, "installed capacity end 2024 (Bundesnetzagentur: solar 99.3 GW, onshore 63.5 GW, offshore 9.2 GW)"),
}
NATIONAL_CAPACITY = Path(__file__).with_name("national_capacity.csv")


SOLAR_TECHS = ["60", "61", "62", "63"]  # PECD PV types: industrial rooftop, residential rooftop, utility fixed, tracking


def national_capacity() -> dict[str, dict[str, float]]:
    """GW per country and technology (ERAA 2025, target year 2028), including spv60-spv63 per PV type."""
    df = pd.read_csv(NATIONAL_CAPACITY, comment="#", index_col="cc")
    return {cc: {k: round(float(v) / 1000, 2) for k, v in row.items()} for cc, row in df.iterrows()}


def load_solar(national: dict) -> pd.DataFrame:
    """National solar capacity factor: the four PECD PV types weighted by each country's capacity per type.

    Countries without a PV split in ERAA keep utility-scale fixed PV (technology 62).
    """
    types = {t: load_raw("spv", sorted((RAW / "spv").glob(f"spv_t{t}_*.zip"))) for t in SOLAR_TECHS}
    out = {}
    for cc in types["62"].columns:
        weights = {t: national.get(cc, {}).get(f"spv{t}", 0) for t in SOLAR_TECHS if cc in types[t]}
        weights = {t: w for t, w in weights.items() if w > 0} or {"62": 1.0}
        out[cc] = sum(types[t][cc] * w for t, w in weights.items()) / sum(weights.values())
    return pd.DataFrame(out).astype("float32")


def mix_weights(cc: str, available: set[str], national: dict) -> dict | None:
    """Default capacities (GW) for the wind/solar mix of a country, for the technologies it has data for."""
    if cc in ACTUAL:
        gw, note = ACTUAL[cc]
    elif cc in national:
        gw, note = national[cc], "ENTSO-E ERAA 2025 capacity expected for 2028"
    else:
        return None
    gw = {k: round(v, 1) for k, v in gw.items() if k in available and v > 0}
    return {"gw": gw, "note": f"Defaults: {note}."} if gw else None


def read_zip(path: Path) -> list[pd.DataFrame]:
    frames = []
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if n.endswith(".csv")):
            with z.open(name) as f:
                df = pd.read_csv(io.TextIOWrapper(f, "utf-8"), comment="#", index_col=0, parse_dates=True)
            frames.append(df.astype("float32"))
    return frames


ZONE_PREFIX = {"GR": "EL"}  # PECD wind zones use ISO GR, NUTS uses EL
ZONE_CAPACITY = Path(__file__).with_name("zone_capacity.csv")
ZONED = ["won", "wof"]  # wind comes per PECD zone, solar and temperature per country


def country_of(column: str) -> str:
    return ZONE_PREFIX.get(column[:2], column[:2])


def zone_capacity() -> dict[str, dict[str, float]]:
    """Installed capacity (MW) per PECD wind zone, per technology, from pipeline/zone_capacity.csv."""
    df = pd.read_csv(ZONE_CAPACITY, comment="#")
    return {tech: dict(zip(g["zone"], g["mw"].astype(float))) for tech, g in df.groupby("tech")}


def to_country(zones: pd.DataFrame, capacity: dict[str, float]) -> pd.DataFrame:
    """Capacity-weighted national capacity factor from PECD zone columns.

    Zones without installed capacity drop out; a country without any known capacity gets no series.
    Hours where a zone has no value are weighted over the zones that do.
    """
    out = {}
    for cc, cols in zones.T.groupby(country_of).groups.items():
        weights = pd.Series({z: capacity.get(z, 0.0) for z in cols})
        weights = weights[weights > 0]
        if weights.empty:
            continue
        block = zones[weights.index]
        present = block.notna()
        total = present.mul(weights, axis=1).sum(axis=1)
        out[cc] = block.fillna(0).mul(weights, axis=1).sum(axis=1) / total.where(total > 0)
    return pd.DataFrame(out).astype("float32")


def load_raw(key: str, zips: list[Path] | None = None) -> pd.DataFrame:
    """Hourly series as delivered: countries (solar, temperature) or PECD zones (wind)."""
    zips = zips if zips is not None else sorted((RAW / key).glob("*.zip"))
    frames = [f for z in zips for f in read_zip(z)]
    if not frames:
        raise SystemExit(f"No data for {key} in {RAW / key}")
    # Files are read in name order, so a later file wins where periods overlap.
    df = pd.concat(frames).sort_index(kind="stable")
    df = df[~df.index.duplicated(keep="last")]
    df.columns = [c if key in ZONED else country_of(c) for c in df.columns]
    if key == "t2m" and df.stack().median() > 100:
        df = df - 273.15
    return df


def load_var(key: str, capacity: dict | None = None, zips: list[Path] | None = None) -> pd.DataFrame:
    """Hourly national series; wind is weighted by installed capacity per zone, solar by capacity per PV type.

    With explicit zips (the projections, which come as utility-scale fixed PV only) solar is read as is.
    """
    if key == "spv" and zips is None:
        return load_solar(national_capacity())
    df = load_raw(key, zips)
    return to_country(df, (capacity or zone_capacity())[key]) if key in ZONED else df


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

    capacity = zone_capacity()
    raw = {k: load_raw(k) for k in ZONED}
    hourly = {k: (to_country(raw[k], capacity[k]) if k in ZONED else load_var(k)) for k in VARS}
    for k, df in hourly.items():
        print(f"{k}: {df.index.min()} .. {df.index.max()}, {len(df.columns)} countries")
    countries = sorted(set(hourly["spv"].columns) & set(names))
    daily = {k: df.resample("D").mean() for k, df in hourly.items()}
    start = min(d.index.min() for d in daily.values()).normalize()
    end = max(d.index.max() for d in daily.values()).normalize()
    days = pd.date_range(start, end, freq="D")
    daily = {k: d.reindex(days) for k, d in daily.items()}
    raw_daily = {k: df.resample("D").mean().reindex(days) for k, df in raw.items()}
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

    national = national_capacity()
    available = {cc: {k for k in CF_VARS if cc in daily[k] and daily[k][cc].notna().any()} for cc in countries}
    weights = {cc: w for cc in countries if (w := mix_weights(cc, available[cc], national))}

    # Daily wind capacity factor of the national fleet (onshore and offshore weighted by ERAA capacity),
    # and the wind capacity that weights each country in a pool.
    wind, wind_gw = {}, {}
    for cc in countries:
        gw = {k: national.get(cc, {}).get(k, 0) for k in ZONED if k in available[cc]}
        gw = {k: v for k, v in gw.items() if v > 0}
        if not gw:
            continue
        total = sum(gw.values())
        wind[cc] = ints(sum(daily[k][cc] * v for k, v in gw.items()) / total, 1000)
        wind_gw[cc] = round(total, 1)
    write(OUT / "wind.json", {"start": str(start.date()), "gw": wind_gw, "countries": wind})

    # Per-zone daily wind for countries with several zones, with each zone's share of the national capacity.
    zoned_countries = []
    for cc in countries:
        obj = {"start": str(start.date())}
        for k in ZONED:
            zones = {z: mw for z, mw in capacity[k].items() if country_of(z) == cc and mw > 0 and z in raw_daily[k]}
            if len(zones) < 2:
                continue
            total = sum(zones.values())
            obj[k] = {z: {"share": round(mw / total, 3), "mw": mw, "values": ints(raw_daily[k][z], 1000)} for z, mw in zones.items()}
        if len(obj) > 1:
            write(OUT / "zones" / f"{cc}.json", obj)
            zoned_countries.append(cc)

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
            "zones": zoned_countries,
            "weights": weights,
        },
    )
    print(f"{len(countries)} countries, {start.date()} .. {last.date()}")


if __name__ == "__main__":
    main()
