"""What people are doing 1, 3 and 6 months after their state unemployment benefits stop,
when they had no job in the last month of benefits. Census SIPP public-use files, pooled
across interview years and linked person-to-person so a spell can be followed across
calendar years. Writes site/data/sipp.json (committed; the files are ~3 GB each, so
this runs locally, not in CI).
Usage: uv run python -m analysis.sipp [--cache DIR]"""
import argparse
import io
import json
import zipfile
from pathlib import Path

import pandas as pd
import pyarrow.csv as pc
import pyarrow.parquet as pq
import yaml

from ingest.fetch import http_get

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "sipp.json"
COLS = ["SSUID", "PNUM", "SPANEL", "SWAVE", "MONTHCODE", "WPFINWGT", "TAGE", "RMESR", "EUC1MNYN"]
# RMESR (monthly employment status recode): 1-5 had a job at least part of the month;
# 6-7 no job, on layoff or looking at least one week; 8 no job, not looking.
EMPLOYED, LOOKING, NOT_LOOKING = {1, 2, 3, 4, 5}, {6, 7}, {8}
HORIZONS = [1, 3, 6]
LONG_SPELL = 5  # months of receipt; at or above this a spell is consistent with exhausting state benefits
MIN_N = 30      # suppress a cell with fewer unweighted people


def extract(year: int, url: str, cache: Path) -> pd.DataFrame:
    """Download one year's public-use file and keep only the columns used here."""
    pq_path = cache / f"sipp{year}.parquet"
    if not pq_path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        zf = zipfile.ZipFile(io.BytesIO(http_get(url.format(year=year), timeout=1800)))
        csv_path = cache / zf.namelist()[0]
        zf.extract(zf.namelist()[0], cache)
        t = pc.read_csv(csv_path, parse_options=pc.ParseOptions(delimiter="|"),
                        convert_options=pc.ConvertOptions(include_columns=COLS, column_types={"SSUID": "string"}))
        pq.write_table(t, pq_path)
        csv_path.unlink()
    d = pq.read_table(pq_path, columns=COLS).to_pandas()
    d["t"] = (year - 1) * 12 + d["MONTHCODE"] - 1  # absolute month index; interview year covers the prior calendar year
    return d


def spell_ends(m: pd.DataFrame) -> pd.DataFrame:
    """One row per benefit spell that ends with the person still without a job.
    m: person-month rows with t, ui (bool), RMESR, WPFINWGT, TAGE."""
    m = m.sort_values(["pid", "t"]).reset_index(drop=True)
    same_person_next = m["pid"].eq(m["pid"].shift(-1)) & m["t"].add(1).eq(m["t"].shift(-1))
    same_person_prev = m["pid"].eq(m["pid"].shift(1)) & m["t"].sub(1).eq(m["t"].shift(1))
    # Spell length: consecutive months of receipt; left-censored when receipt starts in the first observed month
    start = m["ui"] & ~(same_person_prev & m["ui"].shift(1, fill_value=False))
    spell_id = start.cumsum().where(m["ui"])
    m["spell_len"] = m.groupby(spell_id)["ui"].transform("size").where(m["ui"])
    m["left_censored"] = m.groupby(spell_id)["t"].transform("min").eq(m.groupby("pid")["t"].transform("min")).where(m["ui"])
    end = m["ui"] & same_person_next & ~m["ui"].shift(-1, fill_value=False)
    ends = m[end & m["RMESR"].isin(LOOKING | NOT_LOOKING) & m["TAGE"].between(18, 64)].copy()
    status = m.set_index(["pid", "t"])["RMESR"]
    for h in HORIZONS:
        ends[f"s{h}"] = status.reindex(list(zip(ends["pid"], ends["t"] + h))).to_numpy()
    return ends


def shares(ends: pd.DataFrame, h: int) -> dict | None:
    s = ends.dropna(subset=[f"s{h}"])
    if len(s) < MIN_N:
        return None
    w = s["WPFINWGT"]
    pct = lambda codes: float(round(100 * w[s[f"s{h}"].isin(codes)].sum() / w.sum(), 1))
    # Approximate 90% margin on the employed share: binomial with Kish effective sample size.
    # Ignores SIPP's clustered design, so it understates true uncertainty somewhat.
    n_eff = w.sum() ** 2 / (w**2).sum()
    p = pct(EMPLOYED) / 100
    moe = float(round(100 * 1.645 * (p * (1 - p) / n_eff) ** 0.5, 1))
    return {"months_after": h, "n": int(len(s)), "employed": pct(EMPLOYED), "looking": pct(LOOKING),
            "not_looking": pct(NOT_LOOKING), "employed_moe90": moe}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=ROOT / "data" / "sipp")
    args = ap.parse_args()
    src = yaml.safe_load((ROOT / "sources.yaml").read_text())["sipp"]
    years = src["years"]
    d = pd.concat([extract(y, src["url"], args.cache) for y in years], ignore_index=True)
    d = d.dropna(subset=["RMESR"])
    d["pid"] = d["SSUID"] + "-" + d["PNUM"].astype(str) + "-" + d["SPANEL"].astype(str)
    d["ui"] = d["EUC1MNYN"].eq(1)
    d = d.drop_duplicates(["pid", "t"])
    ends = spell_ends(d[["pid", "t", "ui", "RMESR", "WPFINWGT", "TAGE"]])
    ends["group"] = ends["spell_len"].ge(LONG_SPELL).map({True: "long", False: "short"})
    # A short spell that started in the first observed month may really be long; drop it from both groups
    ends = ends[~((ends["group"] == "short") & ends["left_censored"].eq(True))]

    groups = {}
    for g, label in [("long", f"Received benefits {LONG_SPELL}+ months (consistent with running out)"),
                     ("short", f"Received benefits under {LONG_SPELL} months")]:
        e = ends[ends["group"] == g]
        groups[g] = {"label": label, "spells": int(len(e)), "rows": [r for h in HORIZONS if (r := shares(e, h))]}
    groups["all"] = {"label": "Everyone whose benefits ended without a job", "spells": int(len(ends)),
                     "rows": [r for h in HORIZONS if (r := shares(ends, h))]}
    first_y, last_y = years[0] - 1, years[-1] - 1
    OUT.write_text(json.dumps({
        "reference_years": f"{first_y}-{last_y}",
        "interview_years": years,
        "definition": ("Adults 18-64 who received regular state unemployment benefits in a month, had no job that "
                       "month, and did not receive benefits the next month. Status is measured 1, 3 and 6 months "
                       "after the last month of benefits. Weighted with SIPP monthly person weights."),
        "min_n": MIN_N,
        "groups": groups,
    }, indent=1))
    for g, v in groups.items():
        print(g, v["spells"], v["rows"])


if __name__ == "__main__":
    main()
