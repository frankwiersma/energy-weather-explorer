"""Fit the transfer functions that turn weather into Dutch capacity factors, and check HARMONIE against PECD.

PECD computes its capacity factors from ERA5 weather, with bias-corrected wind speeds and power curves per
zone. The outlook needs the same step for HARMONIE, so this script learns it back from PECD:

  wind   per NL zone, capacity factor as a function of the zone's 100 m wind speed (ERA5 averaged over the
         zone the way grid.py averages any grid)
  solar  NL capacity factor (the four PV types, capacity-weighted) as a function of radiation over land, per
         month, because the sun's angle on the panels changes through the year

Each curve is the mean capacity factor per bin, made monotonic up to its peak. The curves are fitted on ERA5
2016-2024 and scored on 2025. Then the first day of archived HARMONIE runs (harmonie.py --sample) is put
through the curves and compared with PECD for the same hours: per zone a scale on HARMONIE's wind speed (and
one on its radiation) is chosen that best reproduces PECD, and the scores before and after are kept.

Writes pipeline/transfer.json.
"""

import json

import numpy as np
import pandas as pd

from fetch_era5 import OUT as ERA5, TRAIN
from grid import era5_points
from harmonie import OUT as HARMONIE
from process import RAW, SOLAR_TECHS, load_raw, national_capacity, zone_capacity
from transfer import PATH, apply, debias, to_cf

WS_BINS = np.arange(0, 35.5, 0.5)
SSRD_BINS = np.arange(0, 1050, 25)
SCALES = np.round(np.arange(0.80, 1.201, 0.01), 2)


def curve(x: pd.Series, y: pd.Series, bins: np.ndarray, min_count: int = 10) -> list[list[float]]:
    """Mean y per x bin, as (bin centre, value) points, monotonic up to the peak and pinned to 0 at x = 0."""
    ok = x.notna() & y.notna()
    idx = np.digitize(x[ok], bins) - 1
    g = pd.DataFrame({"i": idx, "y": y[ok].to_numpy()}).groupby("i")["y"].agg(["mean", "count"])
    g = g[g["count"] >= min_count]
    centres = (bins[g.index] + bins[g.index + 1]) / 2
    values = g["mean"].to_numpy(copy=True)
    peak = int(np.argmax(values))
    values[: peak + 1] = np.maximum.accumulate(values[: peak + 1])
    return [[0.0, 0.0]] + [[round(float(c), 3), round(float(v), 4)] for c, v in zip(centres, values)]


def score(pred, truth) -> dict:
    p, t = np.asarray(pred, dtype="float64"), np.asarray(truth, dtype="float64")
    ok = ~np.isnan(p) & ~np.isnan(t)
    p, t = p[ok], t[ok]
    return {
        "mae": round(float(np.mean(np.abs(p - t))), 4),
        "bias": round(float(np.mean(p - t)), 4),
        "r": round(float(np.corrcoef(p, t)[0, 1]), 4),
        "hours": int(ok.sum()),
    }


def solar_target() -> pd.Series:
    national = national_capacity()["NL"]
    weights = {t: national.get(f"spv{t}", 0) for t in SOLAR_TECHS}
    weights = {t: w for t, w in weights.items() if w > 0}
    types = {t: load_raw("spv", sorted((RAW / "spv").glob(f"spv_t{t}_*.zip")))["NL"] for t in weights}
    return sum(types[t] * w for t, w in weights.items()) / sum(weights.values())


def best_shift(x: pd.Series, y: pd.Series) -> int:
    """Hours to shift radiation so it lines up with PECD's time stamps."""
    corr = {s: x.shift(s).corr(y) for s in (-1, 0, 1)}
    return max(corr, key=corr.get)


def fit_curves(weather: pd.DataFrame, cf: dict, spv: pd.Series, holdout: int) -> dict:
    test = weather.index.year == holdout
    out = {"source": f"ERA5 {min(TRAIN)}-{holdout - 1} against PECD v4.2, scored on {holdout}", "holdout": holdout}
    for tech in ("won", "wof"):
        out[tech] = {}
        for zone, mw in zone_capacity()[tech].items():
            if not zone.startswith("NL") or zone not in cf[tech]:
                continue
            x, y = weather[zone].align(cf[tech][zone], join="inner")
            pts = curve(x[~test], y[~test], WS_BINS)
            out[tech][zone] = {"mw": mw, "curve": pts, "test": score(apply(pts, x[test].to_numpy()), y[test])}
            print(f"{tech} {zone:10s} ERA5 {holdout} {out[tech][zone]['test']}")
    shift = best_shift(weather["ssrd"], spv)
    x, y = weather["ssrd"].shift(shift).align(spv, join="inner")
    t = x.index.year == holdout
    curves, pred = {}, np.full(len(x), np.nan)
    for m in range(1, 13):
        sel = x.index.month == m
        curves[m] = curve(x[sel & ~t], y[sel & ~t], SSRD_BINS)
        pred[sel] = apply(curves[m], x[sel].to_numpy())
    out["spv"] = {"shift": shift, "curves": curves, "test": score(pred[t], y[t])}
    print(f"spv NL       ERA5 {holdout} {out['spv']['test']}")
    return out


def national(cf: dict, spv: pd.Series, idx) -> pd.DataFrame:
    """PECD's national capacity factors with the same capacity weights the outlook uses."""
    zc = zone_capacity()
    out = {}
    for tech in ("won", "wof"):
        zones = {z: mw for z, mw in zc[tech].items() if z.startswith("NL")}
        out[tech] = sum(cf[tech][z].reindex(idx) * mw for z, mw in zones.items()) / sum(zones.values())
    out["spv"] = spv.reindex(idx)
    return pd.DataFrame(out)


def harmonie_check(tf: dict, cf: dict, spv: pd.Series) -> dict | None:
    """Put the first day of each sampled HARMONIE run through the curves and compare with PECD."""
    frames = [pd.read_csv(p, index_col="time", parse_dates=True) for p in sorted((HARMONIE / "sample").glob("*.csv"))]
    if not frames:
        return None
    h = pd.concat(f[(f["lead"] >= 1) & (f["lead"] <= 24)] for f in frames).drop(columns="lead")
    h = h[~h.index.duplicated(keep="last")]
    scale, fit = {}, {}
    for tech in ("won", "wof"):
        for zone, z in tf[tech].items():
            x, y = h[zone].align(cf[tech][zone], join="inner")
            errors = {s: np.nanmean(np.abs(apply(z["curve"], x.to_numpy() * s) - y.to_numpy())) for s in SCALES}
            scale[zone] = float(min(errors, key=errors.get))
            fit[zone] = {"raw": score(apply(z["curve"], x.to_numpy()), y), "scaled": score(apply(z["curve"], x.to_numpy() * scale[zone]), y)}
            print(f"HARMONIE {zone:10s} scale {scale[zone]:.2f}  raw {fit[zone]['raw']}  scaled {fit[zone]['scaled']}")
    x, y = h["ssrd"].shift(tf["spv"]["shift"]).align(spv, join="inner")
    month = x.index.month

    def solar(s):
        return np.concatenate([apply(tf["spv"]["curves"][m], x[month == m].to_numpy() * s) for m in range(1, 13)])

    order = np.concatenate([np.flatnonzero(month == m) for m in range(1, 13)])
    truth = y.to_numpy()[order]
    errors = {s: np.nanmean(np.abs(solar(s) - truth)) for s in SCALES}
    scale["ssrd"] = float(min(errors, key=errors.get))
    fit["spv"] = {"raw": score(solar(1.0), truth), "scaled": score(solar(scale["ssrd"]), truth)}
    print(f"HARMONIE spv        scale {scale['ssrd']:.2f}  raw {fit['spv']['raw']}  scaled {fit['spv']['scaled']}")

    model = to_cf(debias(h, {**tf, "harmonie": {"scale": scale}}), tf)
    truth = national(cf, spv, model.index)
    fit["national"] = {t: score(model[t], truth[t]) for t in ("won", "wof", "spv")}
    print(f"HARMONIE national {fit['national']}")
    return {"scale": scale, "fit": fit, "runs": len(frames), "from": str(h.index.min()), "to": str(h.index.max())}


def main() -> None:
    weather = era5_points(sorted(ERA5.glob("*.csv")))
    cf = {tech: load_raw(tech) for tech in ("won", "wof")}
    spv = solar_target()
    print(f"ERA5 training hours: {len(weather)}")
    tf = fit_curves(weather, cf, spv, max(TRAIN))
    tf["harmonie"] = harmonie_check(tf, cf, spv)
    PATH.write_text(json.dumps(tf))
    print(f"wrote {PATH}")


if __name__ == "__main__":
    main()
