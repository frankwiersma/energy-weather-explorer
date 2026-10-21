"""Summarise the PECD 4.2 projections per country into public/data/future/<CC>.json.

For ERA5 history and for every model/scenario run the same yearly indicators are computed:
  spv, won, wof   annual mean capacity factor
  dunkel          Dunkelflaute days (daily capacity-weighted mix below 6% for at least 2 days)
  lowwind         days on which the wind capacity factor stays below 10%
  monthly         mean capacity factor per calendar month for reference periods
Also adds a "projections" block to meta.json.

With --hist-only the projection part of the existing files is kept and only the ERA5 history is
recomputed, so the weekly refresh does not need the 2.2 GB of projection downloads.

The models reproduce mean capacity factors well (they are bias-adjusted) but not the persistence of calm
spells, so the app compares each model with its own 2015-2044 baseline (delta method) instead of with ERA5.
"""

import json
import sys

import numpy as np
import pandas as pd

from fetch_projections import MODELS, SCENARIOS
from process import CF_VARS, OUT, RAW, WEIGHTS, load_var, read_zip, to_country, write

DUNKEL_THRESHOLD, DUNKEL_MIN_DAYS = 0.06, 2
LOWWIND_THRESHOLD = 0.10
HIST_PERIOD = (1991, 2020)
FUTURE_PERIODS = [(2015, 2044), (2071, 2100)]  # model baseline and end of century

LABELS = {
    "ssp2_4_5": ("SSP2-4.5", "middle of the road, about 2.7 °C warming by 2100"),
    "ssp5_8_5": ("SSP5-8.5", "high emissions, about 4.4 °C warming by 2100"),
    "ec_earth3": "EC-Earth3",
    "mpi_esm1_2_hr": "MPI-ESM1-2-HR",
    "cmcc_cm2_sr5": "CMCC-CM2-SR5",
}


def daily(df: pd.DataFrame) -> pd.DataFrame:
    return df.resample("D").mean()


def dunkel_days(mix: pd.Series) -> pd.Series:
    """Days per calendar year that belong to a run of at least DUNKEL_MIN_DAYS days below the threshold."""
    below = (mix < DUNKEL_THRESHOLD).to_numpy()
    flag = np.zeros(len(below), dtype=bool)
    start = None
    for i, b in enumerate(np.append(below, False)):
        if b and start is None:
            start = i
        elif not b and start is not None:
            if i - start >= DUNKEL_MIN_DAYS:
                flag[start:i] = True
            start = None
    return pd.Series(flag, index=mix.index).groupby(mix.index.year).sum()


def indicators(cf: dict[str, pd.DataFrame], cc: str, years: range, periods: list[tuple[int, int]]) -> dict | None:
    """Yearly indicators for one country from daily capacity factors per technology."""
    techs = {k: cf[k][cc] for k in CF_VARS if cc in cf[k] and cf[k][cc].notna().any()}
    if "spv" not in techs or "won" not in techs:
        return None
    weights = WEIGHTS.get(cc, {}).get("gw", {"spv": 1, "won": 1, "wof": 1})
    total = sum(weights[k] for k in techs)
    mix = sum(techs[k] * weights[k] for k in techs) / total
    wind = pd.concat([techs[k] for k in ("won", "wof") if k in techs], axis=1).mean(axis=1)

    def per_year(s: pd.Series) -> list:
        return [round(float(v), 4) for v in s.reindex(list(years)).to_numpy()]

    out = {k: per_year(s.groupby(s.index.year).mean()) for k, s in techs.items()}
    out["dunkel"] = per_year(dunkel_days(mix))
    out["lowwind"] = per_year((wind < LOWWIND_THRESHOLD).groupby(wind.index.year).sum())
    out["monthly"] = {
        f"{a}–{b}": {
            k: [round(float(v), 4) for v in s[(s.index.year >= a) & (s.index.year <= b)].groupby(lambda t: t.month).mean()]
            for k, s in techs.items()
        }
        for a, b in periods
    }
    return out


def load_run(scenario: str, model: str) -> dict[str, pd.DataFrame]:
    out = {}
    for k in CF_VARS:
        frames = read_zip(RAW / "proj" / scenario / model / f"{k}.zip")
        df = pd.concat([to_country(f) for f in frames]).sort_index()
        out[k] = daily(df[~df.index.duplicated(keep="last")])
    return out


def main() -> None:
    meta = json.loads((OUT / "meta.json").read_text())
    countries = list(meta["countries"])

    hist_cf = {k: daily(load_var(k)) for k in CF_VARS}
    last_full = int(meta["lastDate"][:4]) - (0 if meta["lastDate"].endswith("12-31") else 1)
    hist_years = range(meta["firstYear"], last_full + 1)
    proj_years = range(2015, 2101)

    hist_only = "--hist-only" in sys.argv
    result = {cc: {"hist": None, "proj": {"years": list(proj_years), "runs": {}}} for cc in countries}
    if hist_only:
        for f in (OUT / "future").glob("*.json"):
            if f.stem in result:
                result[f.stem]["proj"] = json.loads(f.read_text())["proj"]
    for cc in countries:
        h = indicators(hist_cf, cc, hist_years, [HIST_PERIOD])
        if h:
            h["monthly"] = h["monthly"][f"{HIST_PERIOD[0]}–{HIST_PERIOD[1]}"]
            result[cc]["hist"] = {"years": list(hist_years), **h}

    for scenario in [] if hist_only else SCENARIOS:
        for model in MODELS:
            run = load_run(scenario, model)
            for cc in countries:
                ind = indicators(run, cc, proj_years, FUTURE_PERIODS)
                if ind and result[cc]["hist"]:
                    result[cc]["proj"]["runs"].setdefault(scenario, {})[model] = ind
            print(f"{scenario} {model}: done", flush=True)

    written = 0
    for cc, obj in result.items():
        if obj["hist"] and obj["proj"]["runs"]:
            write(OUT / "future" / f"{cc}.json", obj)
            written += 1

    if hist_only:
        print(f"{written} countries, history refreshed")
        return
    meta["projections"] = {
        "years": [proj_years[0], proj_years[-1]],
        "scenarios": [{"id": s, "label": LABELS[s][0], "note": LABELS[s][1]} for s in SCENARIOS],
        "models": [{"id": m, "label": LABELS[m]} for m in MODELS],
    }
    write(OUT / "meta.json", meta)
    print(f"{written} countries with projections")


if __name__ == "__main__":
    main()
