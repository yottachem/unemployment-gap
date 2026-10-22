"""Turn data/raw/ into the JSON the site reads: site/data/labor.json (national monthly
series, recessions, freshness) and site/data/benefits.json (state UI first and final
payments, exhaustion rate).
Usage: uv run python -m transform.build_data"""
import json
import shutil
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


def combined_rate(rates: list[pd.Series], levels: list[pd.Series]) -> pd.Series:
    """Unemployment rate for merged industries: total unemployed over total labor force, where
    each industry's labor force is its unemployed level divided by its rate."""
    lf = sum(lv / (r / 100) for r, lv in zip(rates, levels))
    return 100 * sum(levels) / lf


def sector_frames(src: dict) -> dict[str, pd.DataFrame]:
    """Monthly unemployment, hires and layoff rates per sector, with 12-month averages."""
    jolts = json.loads((RAW / "jolts_raw.json").read_text())
    elements = src["bls_api"]["elements"]
    out = {}
    for s in src["sectors"]:
        rates = [read_fred(i) for i in s["cps"]]
        unemp = combined_rate(rates, [read_fred(i) for i in s["cps_levels"]]) if s.get("cps_levels") else rates[0]
        f = pd.DataFrame({"unemp": unemp})
        for e, name in elements.items():
            pts = jolts[src["bls_api"]["jolts_id"].format(code=s["jolts"], element=e)]
            f = f.join(pd.Series({pd.Timestamp(k + "-01"): v for k, v in pts.items()}, name=name), how="outer")
        f = f.sort_index()
        f.index = f.index.to_period("M")
        f = f.reindex(pd.period_range(f.index.min(), f.index.max(), freq="M"))
        for c in ["unemp", "hires", "layoffs"]:
            # 11 of 12: BLS did not collect the October 2025 household survey (federal shutdown)
            f[f"{c}_avg12"] = f[c].rolling(12, min_periods=11).mean()
        out[s["key"]] = f
    return out


def sector_summary(f: pd.DataFrame) -> dict:
    """2019 average vs. the latest 12 months, per metric."""
    res = {}
    for c in ["unemp", "hires", "layoffs"]:
        latest = f[c].last_valid_index()  # last month actually published, not the padded index
        res[c] = {"base": _num(f.loc[pd.Period("2019-01", "M"):pd.Period("2019-12", "M"), c].mean(), 2),
                  "now": _num(f.loc[latest, f"{c}_avg12"], 2), "through": str(latest)}
    return res


def industry_series(src: dict, ces: dict) -> list[dict]:
    """Resolve each industry to its first candidate id with data; index to the 2019 average.
    Unresolved industries are returned with status 'pending'; a stand-in is dropped once the
    industry it stands in for resolves."""
    out = []
    for ind in src["industries"]["list"]:
        sid, pts = None, None
        for cand in ind["ids"]:
            if ind["via"] == "fred" and (RAW / f"fred_{cand}.csv").exists():
                s = read_fred(cand)
            elif ces.get(cand):
                s = pd.Series({pd.Timestamp(k + "-01"): v for k, v in ces[cand].items()}).sort_index()
            else:
                continue
            s = s[s.index >= pd.Timestamp(f"{src['industries']['start_year']}-01-01")]
            if len(s):
                sid, pts = cand, s
                break
        row = {k: ind[k] for k in ("key", "short", "group", "label", "sector")}
        if pts is None:
            out.append({**row, "status": "pending", "candidates": ind["ids"]})
            continue
        base = pts[(pts.index >= "2019-01-01") & (pts.index <= "2019-12-01")].mean()
        out.append({**row, "status": "confirmed", "series_id": sid, "seasonally_adjusted": sid.startswith("CES"),
                    "replaced_by": ind.get("replaced_by"), "base_2019": _num(base, 1),
                    "points": [[d.strftime("%Y-%m"), _num(v, 1), _num(100 * v / base, 1)] for d, v in pts.items()]})
    confirmed = {i["key"] for i in out if i["status"] == "confirmed"}
    return [i for i in out if not (i.get("replaced_by") in confirmed)]


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
    sf = sector_frames(src)
    cols = ["unemp", "hires", "layoffs", "unemp_avg12", "hires_avg12", "layoffs_avg12"]
    (OUT / "sectors.json").write_text(json.dumps({
        "built": now, "columns": ["month", *cols],
        "sectors": [{"key": s["key"], "label": s["label"], "summary": sector_summary(sf[s["key"]]),
                     "data": [[str(m), *(_num(r[c], 2) for c in cols)] for m, r in sf[s["key"]].iterrows()
                              if m >= pd.Period("2000-01", "M")]} for s in src["sectors"]],
    }, separators=(",", ":")))
    shutil.copy(RAW / "jolts_raw.json", OUT / "jolts_raw.json")
    ces_path = RAW / "ces_raw.json"
    ces = json.loads(ces_path.read_text()) if ces_path.exists() else {}
    inds = industry_series(src, ces)
    (OUT / "industries.json").write_text(json.dumps({"built": now, "base": "2019 average = 100", "industries": inds},
                                                    separators=(",", ":")))
    (OUT / "ces_raw.json").write_text(json.dumps(ces))
    for i in inds:
        freshness.append({"id": i.get("series_id", i["key"]), "label": f"Employment: {i['label']}", "source": "BLS Current Employment Statistics",
                          "first": i["points"][0][0] if i["status"] == "confirmed" else None,
                          "latest": i["points"][-1][0] if i["status"] == "confirmed" else None})
    for key, label, source, col in [("JOLTS-industry", "Hires and layoff rates by industry", "BLS JOLTS (BLS API)", "hires"),
                                    ("CPS-industry", "Unemployment rate by industry of last job", "BLS Current Population Survey", "unemp")]:
        c = sf["construction"][col].dropna()
        freshness.append({"id": key, "label": label, "source": source,
                          "first": max(str(c.index.min()), "2000-01"), "latest": str(c.index.max())})
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
    sf = sector_frames(src)
    cols = ["unemp", "hires", "layoffs", "unemp_avg12", "hires_avg12", "layoffs_avg12"]
    (OUT / "sectors.json").write_text(json.dumps({
        "built": now, "columns": ["month", *cols],
        "sectors": [{"key": s["key"], "label": s["label"], "summary": sector_summary(sf[s["key"]]),
                     "data": [[str(m), *(_num(r[c], 2) for c in cols)] for m, r in sf[s["key"]].iterrows()
                              if m >= pd.Period("2000-01", "M")]} for s in src["sectors"]],
    }, separators=(",", ":")))
    shutil.copy(RAW / "jolts_raw.json", OUT / "jolts_raw.json")
    ces_path = RAW / "ces_raw.json"
    ces = json.loads(ces_path.read_text()) if ces_path.exists() else {}
    inds = industry_series(src, ces)
    (OUT / "industries.json").write_text(json.dumps({"built": now, "base": "2019 average = 100", "industries": inds},
                                                    separators=(",", ":")))
    (OUT / "ces_raw.json").write_text(json.dumps(ces))
    for i in inds:
        freshness.append({"id": i.get("series_id", i["key"]), "label": f"Employment: {i['label']}", "source": "BLS Current Employment Statistics",
                          "first": i["points"][0][0] if i["status"] == "confirmed" else None,
                          "latest": i["points"][-1][0] if i["status"] == "confirmed" else None})
    freshness.append({"id": "JOLTS-industry", "label": "Hires and layoff rates by industry", "source": "BLS JOLTS (BLS API)",
                      "first": min(r[0] for r in [[k] for v in json.loads((RAW / "jolts_raw.json").read_text()).values() for k in v]),
                      "latest": max(k for v in json.loads((RAW / "jolts_raw.json").read_text()).values() for k in v)})
    freshness.append({"id": "CPS-industry", "label": "Unemployment rate by industry of last job", "source": "BLS Current Population Survey",
                      "first": "2000-01", "latest": sf["construction"]["unemp"].last_valid_index().strftime("%Y-%m")})
    (OUT / "labor.json").write_text(json.dumps({
        "built": now, "series": series, "recessions": rec, "freshness": freshness,
    }, separators=(",", ":")))
    print(f"labor.json: {len(series)} series; benefits.json: {len(frames)} jurisdictions, through {freshness[-1]['latest']}")


if __name__ == "__main__":
    main()
