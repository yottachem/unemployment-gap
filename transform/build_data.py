"""Turn data/raw/ into the JSON the site reads: site/data/labor.json (national monthly
series, recessions, freshness) and site/data/benefits.json (state UI first and final
payments, exhaustion rate).
Usage: uv run python -m transform.build_data"""
import json
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "site" / "data"

STATES = {
    "AK": "Alaska", "AL": "Alabama", "AR": "Arkansas", "AZ": "Arizona", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DC": "District of Columbia", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "IA": "Iowa", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "MA": "Massachusetts", "MD": "Maryland", "ME": "Maine",
    "MI": "Michigan", "MN": "Minnesota", "MO": "Missouri", "MS": "Mississippi", "MT": "Montana",
    "NC": "North Carolina", "ND": "North Dakota", "NE": "Nebraska", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NV": "Nevada", "NY": "New York", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "PR": "Puerto Rico", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VA": "Virginia",
    "VI": "U.S. Virgin Islands", "VT": "Vermont", "WA": "Washington", "WI": "Wisconsin",
    "WV": "West Virginia", "WY": "Wyoming",
}
TERRITORIES = {"PR", "VI"}

# Federal benefit extensions: state final payments understate how many people ran out of
# all benefits during these windows, because extended weeks followed the state weeks.
POLICY_PERIODS = [
    {"start": "2008-07", "end": "2013-12", "label": "Emergency Unemployment Compensation (federal extension, up to 99 weeks total)"},
    {"start": "2020-03", "end": "2021-09", "label": "Pandemic programs (PEUC, PUA)"},
]


def read_fred(sid: str) -> pd.Series:
    d = pd.read_csv(RAW / f"fred_{sid}.csv", na_values=["."])
    d.columns = ["date", "value"]
    d["date"] = pd.to_datetime(d["date"])
    return d.dropna().set_index("date")["value"]


def recessions(flag: pd.Series) -> list[dict]:
    """Contiguous runs of USREC == 1 as {start, end} month strings."""
    out, start = [], None
    for d, v in flag.items():
        if v == 1 and start is None:
            start = d
        if v != 1 and start is not None:
            out.append({"start": start.strftime("%Y-%m"), "end": prev.strftime("%Y-%m")})
            start = None
        prev = d
    if start is not None:
        out.append({"start": start.strftime("%Y-%m"), "end": prev.strftime("%Y-%m")})
    return out


def exhaustion_rate(first: pd.Series, final: pd.Series) -> pd.Series:
    """DOL definition: final payments summed over the 12 months ending this month, divided by
    first payments summed over the 12 months ending six months earlier."""
    f12 = final.rolling(12, min_periods=12).sum()
    p12 = first.rolling(12, min_periods=12).sum().shift(6)
    return (100 * f12 / p12).where(p12 > 0)


def benefits_frame(raw: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Per-jurisdiction monthly frames plus a U.S. total (50 states + DC)."""
    raw = raw.assign(month=pd.to_datetime(raw["rptdate"]).dt.to_period("M"))
    raw = raw.rename(columns={"c51": "first", "c56": "final"})[["st", "month", "first", "final"]]
    frames = {}
    us = raw[~raw.st.isin(TERRITORIES)].groupby("month")[["first", "final"]].sum(min_count=1)
    for key, g in [("US", us), *((st, g.set_index("month")[["first", "final"]]) for st, g in raw.groupby("st"))]:
        g = g.sort_index()
        g = g.reindex(pd.period_range(g.index.min(), g.index.max(), freq="M"))
        g["final_avg12"] = g["final"].rolling(12, min_periods=12).mean()
        g["first_avg12"] = g["first"].rolling(12, min_periods=12).mean()
        g["exhaust_rate"] = exhaustion_rate(g["first"], g["final"])
        frames[key] = g
    return frames


def _num(v, nd=1):
    return None if pd.isna(v) else round(float(v), nd)


def main() -> None:
    src = yaml.safe_load((ROOT / "sources.yaml").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")

    series, freshness = {}, []
    for sid, meta in src["fred"]["series"].items():
        s = read_fred(sid)
        if sid == "USREC":
            rec = recessions(s)
            continue
        series[sid] = {**meta, "points": [[d.strftime("%Y-%m"), _num(v, 2)] for d, v in s.items()]}
        freshness.append({"id": sid, "label": meta["label"], "source": meta["source"],
                          "first": s.index.min().strftime("%Y-%m"), "latest": s.index.max().strftime("%Y-%m")})

    frames = benefits_frame(pd.read_csv(RAW / "ar5159.csv"))
    us = frames["US"]
    freshness.append({"id": "ETA5159", "label": "State UI first and final payments", "source": "DOL ETA 5159",
                      "first": str(us.index.min()), "latest": str(us["final"].last_valid_index())})

    (OUT / "labor.json").write_text(json.dumps({
        "built": now, "series": series, "recessions": rec, "freshness": freshness,
    }, separators=(",", ":")))

    cols = ["first", "final", "first_avg12", "final_avg12", "exhaust_rate"]
    (OUT / "benefits.json").write_text(json.dumps({
        "built": now,
        "columns": ["month", *cols],
        "policy_periods": POLICY_PERIODS,
        "names": {"US": "United States (50 states + DC)", **{k: STATES.get(k, k) for k in frames if k != "US"}},
        "data": {k: [[str(m), *(_num(r[c], 1 if c == "exhaust_rate" else 0) for c in cols)]
                     for m, r in f.iterrows()] for k, f in frames.items()},
    }, separators=(",", ":")))
    print(f"labor.json: {len(series)} series; benefits.json: {len(frames)} jurisdictions, through {freshness[-1]['latest']}")


if __name__ == "__main__":
    main()
