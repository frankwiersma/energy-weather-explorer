"""Download PECD 4.2 climate projections (2015-2100) for the capacity factors used in the app.

Same technologies as fetch.py, for a selection of emission scenarios and CMIP6 models.
Each model/scenario/variable is one request and lands in data/raw/proj/<scenario>/<model>/<var>.zip.
"""

import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import cdsapi

from fetch import DATASET, RAW, VARIABLES

SCENARIOS = ["ssp2_4_5", "ssp5_8_5"]
MODELS = ["ec_earth3", "mpi_esm1_2_hr", "cmcc_cm2_sr5"]
KEYS = ["spv", "won", "wof"]
YEARS = [str(y) for y in range(2015, 2101)]


def fetch(client: cdsapi.Client, scenario: str, model: str, key: str) -> str:
    target = RAW / "proj" / scenario / model / f"{key}.zip"
    name = f"{scenario}/{model}/{key}"
    if target.exists():
        return f"skip  {name}"
    target.parent.mkdir(parents=True, exist_ok=True)
    request = {
        "pecd_version": "pecd4_2",
        "temporal_period": ["future_projections"],
        "origin": [model],
        "emission_scenario": [scenario],
        **VARIABLES[key],
        "year": YEARS,
        "file_version": ["fv1"],
    }
    partial = target.with_suffix(".part")
    client.retrieve(DATASET, request).download(str(partial))
    partial.rename(target)
    return f"done  {name} ({target.stat().st_size / 1e6:.1f} MB)"


def main() -> None:
    client = cdsapi.Client(quiet=True, progress=False)
    todo = [(s, m, k) for s in SCENARIOS for m in MODELS for k in KEYS]
    print(f"{len(todo)} requests", flush=True)
    failed = 0
    # CDS caps the queued requests per dataset, so keep the pool small.
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fetch, client, *job): "/".join(job) for job in todo}
        for future in as_completed(futures):
            try:
                print(future.result(), flush=True)
            except Exception as exc:  # report and keep the other requests running
                failed += 1
                print(f"FAIL  {futures[future]}: {exc}", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
