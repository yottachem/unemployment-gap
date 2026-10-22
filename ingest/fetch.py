"""Download every scheduled source into data/raw/. Transient upstream errors (timeouts,
429, 5xx) are retried; anything else fails the run.
Usage: uv run python -m ingest.fetch"""
import json
import sys
import time
from datetime import date
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
USER_AGENT = "unemployment-gap/0.1 (open research; github.com/yottachem/unemployment-gap)"


def load_sources() -> dict:
    return yaml.safe_load((ROOT / "sources.yaml").read_text())


def http_get(url: str, retries: int = 4, timeout: int = 120) -> bytes:
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
        except (requests.Timeout, requests.ConnectionError):
            if attempt == retries:
                raise
        else:
            if r.status_code not in (429, 500, 502, 503, 504) or attempt == retries:
                r.raise_for_status()
                return r.content
        time.sleep(min(10 * 2**attempt, 120))
    raise RuntimeError(f"unreachable: {url}")


def jolts_ids(src: dict) -> dict[str, tuple[str, str]]:
    """BLS series id -> (sector key, element name)."""
    api = src["bls_api"]
    return {api["jolts_id"].format(code=s["jolts"], element=e): (s["key"], name)
            for s in src["sectors"] for e, name in api["elements"].items()}


def fetch_jolts(src: dict) -> dict:
    """All sector hires and layoff rates from the BLS API, in 10-year windows."""
    out = fetch_bls(list(jolts_ids(src)), src["bls_api"]["start_year"])
    missing = [i for i, v in out.items() if not v]
    if missing:
        raise RuntimeError(f"BLS API returned no data for {missing}")
    return out


def fetch_bls(ids: list[str], start_year: int) -> dict:
    """Monthly values for BLS series ids via the keyless API. Ids with no data come back empty."""
    api_url = load_sources()["bls_api"]["url"]
    out = {i: {} for i in ids}
    end = date.today().year
    for y0 in range(start_year, end + 1, 10):
        for k in range(0, len(ids), 25):
            body = {"seriesid": ids[k:k + 25], "startyear": str(y0), "endyear": str(min(y0 + 9, end))}
            for attempt in range(4):
                r = requests.post(api_url, json=body, headers={"User-Agent": USER_AGENT}, timeout=180)
                if r.ok and r.json().get("status") == "REQUEST_SUCCEEDED":
                    break
                time.sleep(20 * (attempt + 1))
            else:
                raise RuntimeError(f"BLS API: {r.status_code} {r.text[:200]}")
            for s in r.json()["Results"]["series"]:
                for d in s["data"]:
                    if d["period"].startswith("M") and d["period"] != "M13" and d["value"] not in ("-", ""):
                        out[s["seriesID"]][f"{d['year']}-{d['period'][1:]}"] = float(d["value"])
    return out


def main() -> None:
    src = load_sources()
    RAW.mkdir(parents=True, exist_ok=True)
    sector_cps = {sid for s in src["sectors"] for sid in s["cps"] + s.get("cps_levels", [])} - set(src["fred"]["series"])
    sector_cps |= {i["ids"][0] for i in src["industries"]["list"] if i["via"] == "fred"}
    for sid in [*src["fred"]["series"], *sorted(sector_cps)]:
        body = http_get(src["fred"]["url"].format(id=sid))
        if not body.startswith(b"observation_date"):
            sys.exit(f"FRED {sid}: unexpected response")
        (RAW / f"fred_{sid}.csv").write_bytes(body)
        print(f"fred {sid}: {len(body):,} bytes")
    body = http_get(src["dol_5159"]["url"], timeout=300)
    if not body.startswith(b'"st","rptdate"'):
        sys.exit("DOL 5159: unexpected response")
    (RAW / "ar5159.csv").write_bytes(body)
    print(f"dol 5159: {len(body):,} bytes")

    # The keyless BLS API is rate limited per IP and CI runners share IPs. On failure, reuse the
    # copy published with the live site so one bad day does not take the page down.
    try:
        jolts = fetch_jolts(src)
    except Exception as e:  # noqa: BLE001
        print(f"::warning::BLS API failed ({e}); reusing the published copy")
        jolts = json.loads(http_get(src["site_url"] + "data/jolts_raw.json"))
    (RAW / "jolts_raw.json").write_text(json.dumps(jolts))
    print(f"bls jolts: {len(jolts)} series")

    # Candidate detailed-industry series. Not fatal: an unconfirmed id just stays pending.
    cands = [c for i in src["industries"]["list"] if i["via"] == "bls" for c in i["ids"]]
    try:
        ces = fetch_bls(cands, src["industries"]["start_year"])
    except Exception as e:  # noqa: BLE001
        print(f"::warning::BLS API failed for industry candidates ({e}); trying the published copy")
        try:
            ces = json.loads(http_get(src["site_url"] + "data/ces_raw.json"))
        except Exception:  # noqa: BLE001
            ces = {}
    (RAW / "ces_raw.json").write_text(json.dumps(ces))
    found = sorted(k for k, v in ces.items() if v)
    print(f"bls ces candidates: {len(found)} of {len(cands)} returned data {found}")


if __name__ == "__main__":
    main()
