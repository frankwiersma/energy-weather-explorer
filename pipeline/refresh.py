"""Bring the app data up to date with the latest month on the Climate Data Store.

1. Ask CDS which months exist. If the app already has them, stop (unless --force).
2. Fetch what is missing (fetch.py skips zips that are already there).
3. Rebuild the app data (process.py) and the ERA5 part of the projections (--hist-only).
4. Check the result before anything is committed: the end date moved to the newest month, no
   country disappeared, and every series has values in its final month.

Writes changed=true|false to $GITHUB_OUTPUT when run in GitHub Actions.
"""

import calendar
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import fetch

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"
PY = sys.executable


def output(changed: bool) -> None:
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


def run(*args: str) -> None:
    subprocess.run([PY, *args], cwd=ROOT / "pipeline", check=True)


def check(old_meta: dict, newest: date) -> None:
    meta = json.loads((DATA / "meta.json").read_text())
    errors = []
    if meta["lastDate"] != newest.isoformat():
        errors.append(f"lastDate is {meta['lastDate']}, expected {newest}")
    lost = set(old_meta["countries"]) - set(meta["countries"])
    if lost:
        errors.append(f"countries disappeared: {sorted(lost)}")
    if "projections" in old_meta and "projections" not in meta:
        errors.append("the projections block was lost from meta.json")
    for cc in meta["countries"]:
        series = json.loads((DATA / "country" / f"{cc}.json").read_text())
        for key in ("spv", "won", "t2m"):
            values = series.get(key)
            if values is None:
                continue
            tail = values[-28:]
            if sum(v is None for v in tail) > 2:
                errors.append(f"{cc} {key}: gaps in the last 28 days")
    if errors:
        raise SystemExit("Refresh failed its checks:\n  " + "\n  ".join(errors))
    print(f"Checks passed: {len(meta['countries'])} countries up to {meta['lastDate']}")


def main() -> None:
    old_meta = json.loads((DATA / "meta.json").read_text())
    full, running, month = fetch.available()
    newest = date(running, month, calendar.monthrange(running, month)[1]) if month else date(full, 12, 31)
    print(f"App data up to {old_meta['lastDate']}, CDS up to {newest}", flush=True)
    if newest.isoformat() <= old_meta["lastDate"] and "--force" not in sys.argv:
        print("Nothing new.")
        output(False)
        return
    run("fetch.py")
    run("process.py")
    run("process_projections.py", "--hist-only")
    check(old_meta, newest)
    output(True)


if __name__ == "__main__":
    main()
