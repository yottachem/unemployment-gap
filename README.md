# unemployment-gap

The unemployment rate can be low while people looking for work struggle to find it. This project tracks the numbers behind that gap: how long people stay unemployed, hiring vs. layoffs, how many people use up their state unemployment benefits, and what they are doing in the months after benefits end.

**Site: https://yottachem.github.io/unemployment-gap/**. Rebuilt every weekday from public data.

## Sources

| Source | What it provides | Starts | Refresh |
|--------|------------------|--------|---------|
| BLS Current Population Survey via FRED | Unemployment rate (U-3, U-6), duration of unemployment, employment rate ages 25-54 | 1948 (U-6 1994, median duration 1967) | Monthly |
| BLS JOLTS via FRED | Hiring rate, layoff and discharge rate | Dec 2000 | Monthly |
| DOL ETA 5159 | State UI first payments, final payments (benefits used up), exhaustion rate | 1971 | Monthly |
| Census SIPP public-use files | Status 1, 3, 6 months after benefits end | 2022-2024 pooled | Yearly, computed locally |
| NBER via FRED | Recession dates | 1854 | As announced |

Exhaustion rates use DOL's formula and match DOL's published quarterly rates (checked in `tests/`).

## Run

```sh
uv sync
uv run python -m ingest.fetch            # FRED series and DOL ETA 5159 into data/raw/
uv run python -m transform.build_data    # site/data/labor.json, benefits.json
uv run python site/build.py              # site/dist (static files, JSON, CSV downloads)
uv run pytest
```

Section 4 (SIPP) downloads about 3 GB per year and runs locally, not in CI:

```sh
uv run python -m analysis.sipp           # writes site/data/sipp.json (committed)
```

When Census publishes a new SIPP year (usually summer), add it to `sources.yaml` under `sipp.years`, rerun, and commit `site/data/sipp.json`.

## Layout

| Path | Purpose |
|------|---------|
| `sources.yaml` | Source registry: URLs, series, column mappings, licenses |
| `ingest/fetch.py` | Downloads every scheduled source with retry on transient errors |
| `transform/build_data.py` | Exhaustion rate, 12-month averages, recessions, freshness |
| `analysis/sipp.py` | Links SIPP people across years, finds benefit spells that end without a job, follows them forward |
| `site/static/` | Page, styles, D3 charts |
| `.github/workflows/update.yml` | Weekday fetch, test, build, deploy to GitHub Pages |

## License

Code: MIT. Derived data: CC-BY-4.0. Upstream data is U.S. government public domain.
