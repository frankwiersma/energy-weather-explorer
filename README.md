# Energy Weather Explorer

How the weather drives wind and solar power in Europe: every day since 1950, Dunkelflaute spells, what
pooling wind across countries buys you, and what climate models expect up to 2100. Built on the
Copernicus Pan-European Climate Database (PECD) v4.2, which C3S produces with ENTSO-E.

The whole app fits on one screen. A tile map of Europe picks the country and shows the selected day, a
timeline along the bottom picks the year, and all views share one selected date. Every number has an ⓘ
that explains it.

| View | What it shows |
|---|---|
| Map | Europe on one day, with a day slider, play and speed controls; per metric the normal range and the day's rank since 1950 |
| Country year | Daily wind, solar and temperature against the 1991–2020 normal range |
| Dunkelflaute | Calm, dark spells for an adjustable capacity mix and threshold; hourly detail, a replay on the map and a TimesFM forecast |
| Europe together | How pooling wind with neighbouring countries reduces calm days, and how strongly neighbours move together |
| Weather years | Every month since 1950 against normal, and winters ranked |
| Future climate | Dunkelflaute, low-wind days and capacity factors to 2100 under SSP2-4.5 and SSP5-8.5 |

## Data

All data comes from the Climate Data Store (dataset `sis-energy-pecd`, PECD v4.2):

| Key | Variable | Technology | Aggregation |
|---|---|---|---|
| `spv` | Solar PV capacity factor | 62, utility-scale fixed | country (NUTS 0) |
| `won` | Wind onshore capacity factor | 30, existing fleet, resource grade B | PECD onshore zones, averaged per country |
| `wof` | Wind offshore capacity factor | 20, existing fleet, resource grade B | PECD offshore zones, averaged per country |
| `t2m` | 2 m temperature | | country (NUTS 0) |

History is ERA5 from 1950 to the latest month. Projections (2015–2100) come from three CMIP6 models
(EC-Earth3, MPI-ESM1-2-HR, CMCC-CM2-SR5) under SSP2-4.5 and SSP5-8.5, with the same technology as the
history. The models match ERA5 mean capacity factors but overstate how long calm spells last, so each model
is compared with its own 2015–2044 baseline and that change is added to today's ERA5 level.

## Forecasting with TimesFM

The Dunkelflaute view can forecast the next 24, 48 or 96 hours of the wind and solar mix with
[TimesFM 3.0](https://huggingface.co/google/timesfm-3.0-pytorch), Google's time-series foundation model,
running in the browser with ONNX Runtime Web (int8 export, 353 MB, downloaded once and cached).

It is only used where it beats simple baselines. Backtest on 300 random starting hours in 2015–2025,
improvement in mean absolute error over the better of persistence and the 30-day hourly normal:

| Mix | 24 h | 48 h | 96 h |
|---|--:|--:|--:|
| Netherlands | +26% | +12% | +7% |
| Germany | +33% | +25% | +7% |

The p10–p90 band covers 78–81% of the truth. For daily values months ahead and for annual temperature it
does not beat the climate normal or a linear trend, so it is not offered there.

## Pipeline

| Script | What it does |
|---|---|
| `pipeline/fetch.py` | Downloads the history; asks CDS which months exist and fetches only what is missing |
| `pipeline/fetch_projections.py` | Downloads the projections (once, about 2.2 GB) |
| `pipeline/process.py` | Builds `public/data/`: daily series per country, daily values per year for the map, hourly data for NL and DE, a wind series for pooling, `meta.json` |
| `pipeline/process_projections.py` | Adds yearly indicators per country in `public/data/future/`; `--hist-only` refreshes the ERA5 part without the projection downloads |
| `pipeline/refresh.py` | Checks CDS for a new month, then fetches, rebuilds and checks the result |

CDS charges one unit per year in a request (limit 300) and caps queued requests per dataset, so the scripts
send one request per variable and run at most three at a time.

## Updates

`.github/workflows/refresh.yml` runs twice a week. PECD adds a month about three weeks after it ends, so
most runs stop after one request. When there is a new month it fetches the running year, rebuilds the data,
checks it (newest month present, no country lost, no gaps) and commits it; the push deploys the site. The
ERA5 history lives in the Actions cache; after a cache miss it is downloaded again.

It needs one repository secret, `CDSAPI_KEY`: the API key from your CDS profile, with the PECD licence
accepted on the dataset page.

## Run locally

```bash
bun install
bun run dev
```

To rebuild the data you need a CDS account and `~/.cdsapirc`:

```bash
uv venv .venv && uv pip install --python .venv/bin/python cdsapi pandas requests
.venv/bin/python pipeline/fetch.py
.venv/bin/python pipeline/fetch_projections.py
.venv/bin/python pipeline/process.py
.venv/bin/python pipeline/process_projections.py
```

## Deploy

A static site on Cloudflare Workers (static assets are free and unlimited):

```bash
bun run build
npx wrangler deploy
```

The ONNX Runtime WASM file (27.8 MB) is larger than the 25 MiB per-file limit for static assets, so it is
loaded from R2 together with the TimesFM weights.

## Sources and licence

- Copernicus Climate Change Service (2024): Climate and energy related variables from the Pan-European
  Climate Database derived from reanalysis and climate projections. C3S Climate Data Store (CDS),
  DOI [10.24381/cds.f323c5ec](https://doi.org/10.24381/cds.f323c5ec). Licence CC BY 4.0. Neither the
  European Commission nor ECMWF is responsible for any use of this information.
- Map outlines: © EuroGeographics for the administrative boundaries (Eurostat GISCO).
- Installed capacities for the default mix: CBS and RVO (Netherlands), Bundesnetzagentur (Germany), end 2024.
- TimesFM 3.0 by Google Research, Apache 2.0.

The code is MIT licensed. The data in `public/data/` is derived from the sources above and keeps their licences.
