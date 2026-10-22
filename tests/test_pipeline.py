import pandas as pd
import pytest

from analysis.sipp import spell_ends
from transform.build_data import RAW, benefits_frame, exhaustion_rate, recessions


def test_exhaustion_rate_uses_six_month_lagged_denominator():
    idx = pd.period_range("2020-01", periods=24, freq="M")
    first = pd.Series(100.0, index=idx)
    final = pd.Series(40.0, index=idx)
    r = exhaustion_rate(first, final)
    assert r.iloc[:17].isna().all()          # needs 12 months of finals and 12 lagged months of firsts
    assert r.iloc[17] == pytest.approx(40.0)


def test_recessions_runs():
    s = pd.Series([0, 1, 1, 0, 1], index=pd.date_range("2020-01-01", periods=5, freq="MS"))
    assert recessions(s) == [{"start": "2020-02", "end": "2020-03"}, {"start": "2020-05", "end": "2020-05"}]


def test_spell_end_followed_forward():
    # Person a: benefits months 0-5, no job, then job from month 8. Person b: benefits end while employed (excluded).
    rows = []
    for t in range(14):
        rows.append({"pid": "a", "t": t, "ui": t <= 5, "RMESR": 6 if t < 8 else 1, "WPFINWGT": 1.0, "TAGE": 40})
        rows.append({"pid": "b", "t": t, "ui": 2 <= t <= 4, "RMESR": 1, "WPFINWGT": 1.0, "TAGE": 40})
    e = spell_ends(pd.DataFrame(rows))
    assert list(e["pid"]) == ["a"]
    r = e.iloc[0]
    assert (r["t"], r["spell_len"], r["s1"], r["s3"], r["s6"]) == (5, 6, 6, 1, 1)


@pytest.mark.skipif(not (RAW / "ar5159.csv").exists(), reason="run ingest.fetch first")
def test_matches_dol_published_exhaustion_rates():
    # DOL UI Data Summary, CY 2026.2 (12 months ending June 2026)
    frames = benefits_frame(pd.read_csv(RAW / "ar5159.csv"))
    for st, published in {"MA": 38.38, "CA": 50.26, "NC": 53.42, "VT": 16.12, "TX": 43.88}.items():
        assert frames[st].loc[pd.Period("2026-06", "M"), "exhaust_rate"] == pytest.approx(published, abs=0.15)  # allows small late revisions


def test_combined_rate_weights_by_labor_force():
    from transform.build_data import combined_rate
    # A: 10 unemployed at 5% (labor force 200); B: 30 unemployed at 10% (labor force 300) -> 40 / 500 = 8%
    r = combined_rate([pd.Series([5.0]), pd.Series([10.0])], [pd.Series([10.0]), pd.Series([30.0])])
    assert r.iloc[0] == pytest.approx(8.0)
