"""Download every scheduled source into data/raw/. Transient upstream errors (timeouts,
429, 5xx) are retried; anything else fails the run.
Usage: uv run python -m ingest.fetch"""
import sys
import time
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


def main() -> None:
    src = load_sources()
    RAW.mkdir(parents=True, exist_ok=True)
    for sid in src["fred"]["series"]:
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


if __name__ == "__main__":
    main()
