"""Download PECD 4.2 historical (ERA5) time series from the Copernicus Climate Data Store.

Needs ~/.cdsapirc with the CDS API key and the dataset licence accepted on the CDS site.

Each job is one CDS request and lands as a zip in data/raw/<var>/:
  <var>_1950-2025.zip     the base block, fetched once (temperature is split at 2021/2022,
                          where the file version changes)
  <var>_<year>.zip        every complete year after 2025
  <var>_<year>_mMM.zip    the running year up to month MM
Solar comes as four PV types (60 industrial rooftop, 61 residential rooftop, 62 utility fixed,
63 utility tracking), one request per type: spv_t60_1950-2025.zip and so on.
A request costs one unit per year with a limit of 300, and CDS caps queued requests per dataset,
hence few large requests and a small worker pool. Existing zips are skipped, so a rerun only
fetches what is missing.
"""

import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cdsapi
import requests

DATASET = "sis-energy-pecd"
CATALOGUE = f"https://cds.climate.copernicus.eu/api/catalogue/v1/collections/{DATASET}"
RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
FIRST_YEAR, BASE_END = 1950, 2025

BASE = {"pecd_version": "pecd4_2", "temporal_period": ["historical"], "origin": ["era5_reanalysis"]}

SOLAR_TECHS = ["60", "61", "62", "63"]

VARIABLES = {
    "spv": {
        "variable": ["solar_photovoltaic_generation_capacity_factor"],
        "technology": ["62"],
        "spatial_resolution": ["nuts_0"],
    },
    "won": {
        "variable": ["wind_power_onshore_capacity_factor"],
        "technology": ["30"],
        "energy_scenario": ["resource_grade_b"],
        "spatial_resolution": ["peon"],
    },
    "wof": {
        "variable": ["wind_power_offshore_capacity_factor"],
        "technology": ["20"],
        "energy_scenario": ["resource_grade_b"],
        "spatial_resolution": ["peof"],
    },
    "t2m": {
        "variable": ["2m_temperature"],
        "spatial_resolution": ["nuts_0"],
    },
}


def available() -> tuple[int, int, int]:
    """(last complete year, running year, its last month) for ERA5 solar PV, from the CDS constraints."""
    links = requests.get(CATALOGUE, timeout=60).json()["links"]
    url = next(link["href"] for link in links if link["rel"] == "constraints")
    constraints = requests.get(url, timeout=60).json()
    full, partial = 0, {}
    for c in constraints:
        if "era5_reanalysis" not in c.get("origin", []) or "solar_photovoltaic_generation_capacity_factor" not in c.get("variable", []):
            continue
        years = [int(y) for y in c["year"]]
        if "month" in c:
            for y in years:
                partial[y] = max(partial.get(y, 0), max(int(m) for m in c["month"]))
        else:
            full = max(full, *years)
    running = max(partial) if partial else full + 1
    return full, running, partial.get(running, 0)


def request(key: str, years: list[int], months: list[int] | None = None) -> dict:
    # Temperature before 2022 only exists as file version 2.
    fv = "fv2" if key == "t2m" and max(years) <= 2021 else "fv1"
    req = {**BASE, **VARIABLES[key], "year": [str(y) for y in years], "file_version": [fv]}
    if months:
        req["month"] = [f"{m:02d}" for m in months]
    return req


def jobs(full: int, running: int, month: int) -> list[tuple[str, str, dict]]:
    out = []
    for key in VARIABLES:
        variants = [(f"{key}_t{t}", {"technology": [t]}) for t in SOLAR_TECHS] if key == "spv" else [(key, {})]
        for prefix, extra in variants:
            def add(name: str, years: list[int], months: list[int] | None = None) -> None:
                out.append((key, f"{prefix}_{name}", {**request(key, years, months), **extra}))

            if key == "t2m":
                add(f"{FIRST_YEAR}-2021", list(range(FIRST_YEAR, 2022)))
                add(f"2022-{BASE_END}", list(range(2022, BASE_END + 1)))
            else:
                add(f"{FIRST_YEAR}-{BASE_END}", list(range(FIRST_YEAR, BASE_END + 1)))
            for y in range(BASE_END + 1, full + 1):
                add(str(y), [y])
            if month:
                add(f"{running}_m{month:02d}", [running], list(range(1, month + 1)))
    return out


def clean(wanted: set[str]) -> None:
    """Remove partial-year zips that a longer partial or a complete year has replaced."""
    for zip_path in RAW.glob("*/*_m??.zip"):
        if zip_path.stem not in wanted:
            print(f"drop  {zip_path.stem}")
            zip_path.unlink()


def fetch(client: cdsapi.Client, key: str, name: str, req: dict) -> str:
    target = RAW / key / f"{name}.zip"
    if target.exists():
        return f"skip  {name}"
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    client.retrieve(DATASET, req).download(str(partial))
    partial.rename(target)
    return f"done  {name} ({target.stat().st_size / 1e6:.1f} MB)"


def main() -> None:
    full, running, month = available()
    print(f"CDS has complete years up to {full} and {running} up to month {month}", flush=True)
    todo = jobs(full, running, month)
    clean({name for _, name, _ in todo})
    client = cdsapi.Client(quiet=True, progress=False)
    failed = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fetch, client, *job): job[1] for job in todo}
        for future in as_completed(futures):
            try:
                print(future.result(), flush=True)
            except Exception as exc:  # report and keep the other requests running
                failed += 1
                print(f"FAIL  {futures[future]}: {exc}", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
