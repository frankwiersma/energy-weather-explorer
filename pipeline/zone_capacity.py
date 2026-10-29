"""Installed wind capacity per PECD v4.2 zone, for capacity-weighted national capacity factors.

PECD delivers wind capacity factors per zone (PEON onshore, PEOF offshore), and no official table of
installed capacity per zone is published. This script builds one from open data:

  zone geometry   PECD v4.2 region masks (CDS dataset sis-energy-pecd), fractional, on the 0.25 degree grid
  onshore         GOWIRES v1.0, global onshore wind turbines, Zenodo 10.5281/zenodo.18768952, CC BY 4.0
  offshore        Open European offshore wind turbine database, Zenodo record 17311571, ODbL

Each turbine goes to the zone of its own country with the largest mask share in its grid cell (or the
nearest cells, up to three cells away). Onshore turbines without a rated power get the median of their
country. Offshore turbines count from their commissioning month up to CUTOFF.

Writes pipeline/zone_capacity.csv (zone, tech, mw, turbines). The turbine databases give good shares
within a country but not reliable national totals (missing ratings, decommissioned turbines), so national
capacities per technology come from ENTSO-E ERAA 2025 (target year 2028, units available on the market)
and go to pipeline/national_capacity.csv. Run it again when the sources are updated; the app does not
need it at runtime.
"""

import sys
from datetime import date
from pathlib import Path

import cdsapi
import numpy as np
import pandas as pd
import requests
import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "data" / "raw" / "zones"
OUT = Path(__file__).with_name("zone_capacity.csv")
NATIONAL = Path(__file__).with_name("national_capacity.csv")
CUTOFF = sys.argv[1] if len(sys.argv) > 1 else date.today().strftime("%Y-%m")

GOWIRES = "https://zenodo.org/records/18768952/files/GOWIRES_V1.csv?download=1"
OFFSHORE = "https://zenodo.org/records/17311571/files/20251218_eww_opendatabase.csv?download=1"
ERAA = "https://eepublicdownloads.blob.core.windows.net/public-cdn-container/clean-documents/sdc-documents/ERAA/ERAA_2025_Dashboard_RawData.zip"
# ERAA technology -> app key; the four PV types match PECD technologies 60-63.
ERAA_TECH = {
    "Wind onshore": "won", "Wind offshore fixed": "wof", "Wind offshore floating": "wof",
    "Solar PV rooftop industrial": "spv60", "Solar PV rooftop residential": "spv61",
    "Solar PV utility non-tracking": "spv62", "Solar PV utility tracking": "spv63",
}
NODE_COUNTRY = {"GR": "EL"}  # market nodes use ISO GR, the app uses NUTS EL

COUNTRY = {
    "Albania": "AL", "Austria": "AT", "Belgium": "BE", "Bosnia and Herzegovina": "BA", "Bulgaria": "BG",
    "Croatia": "HR", "Cyprus": "CY", "Czech Republic": "CZ", "Denmark": "DK", "Estonia": "EE", "Finland": "FI",
    "France": "FR", "Germany": "DE", "Greece": "GR", "Hungary": "HU", "Ireland": "IE", "Italy": "IT",
    "Latvia": "LV", "Lithuania": "LT", "Luxembourg": "LU", "Moldova": "MD", "Montenegro": "ME",
    "Netherlands": "NL", "North Macedonia": "MK", "Norway": "NO", "Poland": "PL", "Portugal": "PT",
    "Romania": "RO", "Serbia": "RS", "Slovakia": "SK", "Slovenia": "SI", "Spain": "ES", "Sweden": "SE",
    "Switzerland": "CH", "Turkey": "TR", "Ukraine": "UA", "United Kingdom": "UK",
}


def download(url: str, target: Path) -> Path:
    if not target.exists():
        print(f"download {target.name}", flush=True)
        with requests.get(url, stream=True, timeout=120) as r:
            r.raise_for_status()
            part = target.with_suffix(".part")
            with open(part, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            part.rename(target)
    return target


def masks() -> dict[str, xr.DataArray]:
    files = {"won": WORK / "ANCI_PEON-mask_PECD4.2_fv1.nc", "wof": WORK / "ANCI_PEOF-mask_PECD4.2_fv1.nc"}
    if not all(f.exists() for f in files.values()):
        zip_path = WORK / "masks.zip"
        cdsapi.Client(quiet=True).retrieve(
            "sis-energy-pecd",
            {"pecd_version": "pecd4_2", "variable": ["peon_region_mask", "peof_region_mask"], "file_version": ["fv1"]},
        ).download(str(zip_path))
        import zipfile

        with zipfile.ZipFile(zip_path) as z:
            for f in files.values():
                f.write_bytes(z.read(next(n for n in z.namelist() if n.endswith(f.name))))
    return {k: xr.open_dataset(f)["mask"].load() for k, f in files.items()}


def assign(turbines: pd.DataFrame, mask: xr.DataArray) -> pd.Series:
    """Zone per turbine: the own-country zone with the largest mask share in or near its grid cell."""
    lat0, lon0 = float(mask.latitude[0]), float(mask.longitude[0])
    nlat, nlon = mask.sizes["latitude"], mask.sizes["longitude"]
    regions = np.array([str(r) for r in mask.region.values])
    values = mask.values  # region, latitude, longitude
    zone = pd.Series(index=turbines.index, dtype=object)
    for cc, group in turbines.groupby("cc"):
        own = np.flatnonzero(np.char.startswith(regions.astype(str), cc))
        if own.size == 0:
            continue
        i = np.clip(np.rint((lat0 - group["latitude"].to_numpy()) / 0.25).astype(int), 0, nlat - 1)
        j = np.clip(np.rint((group["longitude"].to_numpy() - lon0) / 0.25).astype(int), 0, nlon - 1)
        for (ii, jj), idx in pd.Series(group.index).groupby([i, j]):
            for ring in range(4):
                window = values[own, max(ii - ring, 0) : ii + ring + 1, max(jj - ring, 0) : jj + ring + 1]
                best = window.reshape(own.size, -1).max(axis=1)
                if best.max() > 0:
                    zone.loc[idx.to_numpy()] = regions[own[best.argmax()]]
                    break
    return zone


def national() -> pd.DataFrame:
    """MW per country and technology from ERAA 2025 (final), target year 2028, available on the market, and
    the average demand (MW) per country for the same target year, for the demand proxy."""
    import io
    import zipfile

    with zipfile.ZipFile(download(ERAA, WORK / "eraa_dashboard.zip")) as z:
        name = next(n for n in z.namelist() if n.endswith("GenerationCapacities.csv"))
        df = pd.read_csv(io.BytesIO(z.read(name)), encoding="utf-8-sig")
    df = df[(df["data_version"] == "ERAA 2025 final") & (df["Target year"] == 2028)
            & (df["Operational_Status"] == "Available on market")]
    df = df[df["Technology"].isin(ERAA_TECH)]
    df["tech"] = df["Technology"].map(ERAA_TECH)
    df["cc"] = df["Market_Node"].str[:2].map(lambda c: NODE_COUNTRY.get(c, c))
    table = df.pivot_table(index="cc", columns="tech", values="Value", aggfunc="sum", fill_value=0)
    table = table.reindex(columns=["won", "wof", "spv60", "spv61", "spv62", "spv63"], fill_value=0)
    table.insert(0, "spv", table[["spv60", "spv61", "spv62", "spv63"]].sum(axis=1))
    with zipfile.ZipFile(WORK / "eraa_dashboard.zip") as z:
        name = next(n for n in z.namelist() if n.endswith("Aggregated_Demand.csv"))
        dem = pd.read_csv(io.BytesIO(z.read(name)), encoding="utf-8-sig")
    dem = dem[(dem["data version"] == "ERAA 2025 final") & (dem["Target_Year"] == 2028)
              & (dem["Measure"] == "Hourly Demand (GW)") & (dem["Measure_Type"] == "AVG")]
    dem["cc"] = dem["Market_Node"].str[:2].map(lambda c: NODE_COUNTRY.get(c, c))
    table["demand"] = dem.groupby("cc")["Value"].sum() * 1000
    return table.fillna(0).round(0).astype(int)


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    nat = national()
    NATIONAL.write_text(
        "# Installed capacity (MW) per country, ENTSO-E ERAA 2025 final, target year 2028, units available on the\n"
        "# market (GenerationCapacities.csv in ERAA_2025_Dashboard_RawData.zip), and average demand (MW) for the same\n"
        "# target year (Aggregated_Demand.csv), built by pipeline/zone_capacity.py.\n"
        + nat.to_csv()
    )
    print(f"wrote {len(nat)} countries to {NATIONAL.name}")
    m = masks()

    on = pd.read_csv(download(GOWIRES, WORK / "gowires.csv"), sep=";", encoding="latin-1",
                     usecols=["longitude", "latitude", "country", "power"])
    on["cc"] = on["country"].map(COUNTRY)
    on = on.dropna(subset=["cc"])
    on["power"] = pd.to_numeric(on["power"], errors="coerce").where(lambda p: p > 0)
    on["mw"] = on["power"].fillna(on.groupby("cc")["power"].transform("median"))
    on["zone"] = assign(on, m["won"])

    off = pd.read_csv(download(OFFSHORE, WORK / "offshore.csv"))
    off["cc"] = off["country"].map(COUNTRY)
    off = off[off["cc"].notna() & (off["commissioning_date"].astype(str).str[:7] <= CUTOFF)]
    off["mw"] = pd.to_numeric(off["rated_power"], errors="coerce")
    off["zone"] = assign(off, m["wof"])

    rows = []
    for tech, df in (("won", on), ("wof", off)):
        missing = df["zone"].isna().sum()
        print(f"{tech}: {len(df)} turbines, {df['mw'].sum() / 1000:.1f} GW, {missing} without a zone")
        grouped = df.dropna(subset=["zone"]).groupby("zone").agg(mw=("mw", "sum"), turbines=("mw", "size"))
        rows += [{"zone": z, "tech": tech, "mw": round(r.mw, 1), "turbines": int(r.turbines)} for z, r in grouped.iterrows()]
    table = pd.DataFrame(rows).sort_values(["tech", "zone"])
    header = (
        "# Installed wind capacity per PECD v4.2 zone, built by pipeline/zone_capacity.py.\n"
        "# Onshore: GOWIRES v1.0 (Zenodo 10.5281/zenodo.18768952, CC BY 4.0), missing rated power filled\n"
        "#   with the country median. Offshore: Open European offshore wind turbine database\n"
        f"#   (Zenodo record 17311571, ODbL), commissioned up to {CUTOFF}. Zones: PECD v4.2 region masks (C3S).\n"
    )
    OUT.write_text(header + table.to_csv(index=False))
    print(f"wrote {len(table)} zones to {OUT.name}")


if __name__ == "__main__":
    main()
