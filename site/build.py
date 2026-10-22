"""Assemble the public site into site/dist: static files, JSON data, and CSV downloads.
Usage: uv run python site/build.py"""
import json
import shutil
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(HERE / "static", DIST)
    (DIST / "data").mkdir()
    for f in ["labor.json", "benefits.json", "sipp.json"]:
        shutil.copy(HERE / "data" / f, DIST / "data" / f)

    labor = json.loads((HERE / "data" / "labor.json").read_text())
    wide = pd.concat({sid: pd.Series(dict(s["points"]), name=sid) for sid, s in labor["series"].items()}, axis=1).sort_index()
    wide.index.name = "month"
    wide.to_csv(DIST / "data" / "labor.csv")

    b = json.loads((HERE / "data" / "benefits.json").read_text())
    rows = [[st, *r] for st, data in b["data"].items() for r in data]
    pd.DataFrame(rows, columns=["state", *b["columns"]]).to_csv(DIST / "data" / "benefits.csv", index=False)
    (DIST / ".nojekyll").touch()
    print(f"site/dist: {sum(1 for _ in DIST.rglob('*') if _.is_file())} files")


if __name__ == "__main__":
    main()
