"""Turn zone weather into Dutch capacity factors with the curves fitted by calibrate.py (pipeline/transfer.json)."""

import json
from pathlib import Path

import numpy as np
import pandas as pd

PATH = Path(__file__).with_name("transfer.json")


def load() -> dict:
    return json.loads(PATH.read_text())


def apply(points: list[list[float]], x: np.ndarray) -> np.ndarray:
    xs, ys = np.array(points).T
    return np.interp(x, xs, ys, left=0.0, right=ys[-1])


def debias(weather: pd.DataFrame, tf: dict) -> pd.DataFrame:
    """Scale HARMONIE's zone wind speeds and radiation to the weather the curves were fitted on."""
    scale = (tf.get("harmonie") or {}).get("scale", {})
    return weather.assign(**{c: weather[c] * s for c, s in scale.items() if c in weather})


def to_cf(weather: pd.DataFrame, tf: dict) -> pd.DataFrame:
    """Zone wind speeds and land radiation -> national onshore, offshore and solar capacity factors."""
    out = {}
    for tech in ("won", "wof"):
        num, den = 0.0, 0.0
        for zone, z in tf[tech].items():
            num = num + apply(z["curve"], weather[zone].to_numpy()) * z["mw"]
            den += z["mw"]
        out[tech] = num / den
    ssrd = weather["ssrd"].shift(tf["spv"]["shift"]).to_numpy()
    spv = np.full(len(weather), np.nan)
    for m, pts in tf["spv"]["curves"].items():
        sel = weather.index.month == int(m)
        spv[sel] = apply(pts, ssrd[sel])
    out["spv"] = spv
    return pd.DataFrame(out, index=weather.index)
