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
    for f in ["labor.json", "benefits.json", "sipp.json", "sectors.json", "jolts_raw.json", "industries.json", "ces_raw.json"]:
        shutil.copy(HERE / "data" / f, DIST / "data" / f)

    labor = json.loads((HERE / "data" / "labor.json").read_text())
    wide = pd.concat({sid: pd.Series(dict(s["points"]), name=sid) for sid, s in labor["series"].items()}, axis=1).sort_index()
    wide.index.name = "month"
    wide.to_csv(DIST / "data" / "labor.csv")

    b = json.loads((HERE / "data" / "benefits.json").read_text())
    rows = [[st, *r] for st, data in b["data"].items() for r in data]
    pd.DataFrame(rows, columns=["state", *b["columns"]]).to_csv(DIST / "data" / "benefits.csv", index=False)
    sec = json.loads((HERE / "data" / "sectors.json").read_text())
    rows = [[s["label"], *r] for s in sec["sectors"] for r in s["data"]]
    pd.DataFrame(rows, columns=["sector", *sec["columns"]]).to_csv(DIST / "data" / "sectors.csv", index=False)
    ind = json.loads((HERE / "data" / "industries.json").read_text())
    rows = [[i["label"], i["sector"], i["series_id"], *p] for i in ind["industries"] if i["status"] == "confirmed" for p in i["points"]]
    pd.DataFrame(rows, columns=["industry", "sector", "series_id", "month", "employment_thousands", "index_2019"]).to_csv(DIST / "data" / "industries.csv", index=False)
    (DIST / ".nojekyll").touch()
    print(f"site/dist: {sum(1 for _ in DIST.rglob('*') if _.is_file())} files")


if __name__ == "__main__":
    main()
