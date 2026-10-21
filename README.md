<h1 align="center">Energy Weather Explorer</h1>

<p align="center">
  <b>How the weather drives wind and solar power in Europe, every day since 1950.</b><br />
  Dunkelflaute spells, what pooling wind across countries buys you, and what climate models expect up to 2100.
</p>

<p align="center">
  <a href="https://energy-weather.frankwiersma.workers.dev"><img alt="Live demo" src="https://img.shields.io/badge/live%20demo-energy--weather-003584?style=for-the-badge&logo=cloudflare&logoColor=white" /></a>
  <a href="https://cds.climate.copernicus.eu/datasets/sis-energy-pecd"><img alt="Data: Copernicus PECD v4.2" src="https://img.shields.io/badge/data-Copernicus%20PECD%20v4.2-3C8CFA?style=for-the-badge" /></a>
  <a href="https://github.com/frankwiersma/energy-weather-explorer/actions/workflows/refresh.yml"><img alt="Data refresh" src="https://img.shields.io/github/actions/workflow/status/frankwiersma/energy-weather-explorer/refresh.yml?style=for-the-badge&label=data%20refresh" /></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-FF6428?style=for-the-badge" /></a>
</p>

<p align="center">
  <a href="https://energy-weather.frankwiersma.workers.dev"><img src="docs/demo.gif" alt="The map playing through the storms of February 2020, then pooling wind across Europe" width="900" /></a>
</p>

<p align="center">
  <a href="https://energy-weather.frankwiersma.workers.dev"><b>Open the app</b></a> ·
  <a href="#what-it-shows">What it shows</a> ·
  <a href="#forecasting-with-timesfm">TimesFM in the browser</a> ·
  <a href="#data">Data</a> ·
  <a href="#updates">How it stays current</a>
</p>

---

## A few things the data shows

- **The Netherlands has about 9 Dunkelflaute days a year.** That is a run of at least two days on which the
  wind and solar mix stays under 6% of installed capacity. The worst spell since 1950 was 18 to 27 December 2006:
  ten days at 2.6%.
- **Sharing wind only helps with countries whose weather differs.** Belgium's wind moves almost in step with the
  Dutch (r = 0.9), so adding it changes nothing. Germany and the UK do: pooled with its five nearest neighbours, the
  Netherlands goes from 63 to 30 calm days a year.
- **A time-series model can see the next day or two coming, not the next season.** TimesFM beats persistence and
  the hourly normal by 12–33% up to 48 hours ahead, and adds nothing for the months ahead.
- **Climate change barely moves average wind and solar output in these models.** The change by 2100 is a few
  percent, often smaller than the disagreement between models.

## What it shows

The whole app fits on one screen. A tile map of Europe picks the country and shows the selected day, a timeline
along the bottom picks the year, and all views share one selected date. Every number has an ⓘ that explains it.

<table>
  <tr>
    <td width="50%"><a href="docs/map.png"><img src="docs/map.png" alt="Map view" /></a><br /><b>Map</b>: Europe on one day, with a day slider and play controls. Per metric the normal range and the day's rank since 1950.</td>
    <td width="50%"><a href="docs/country.png"><img src="docs/country.png" alt="Country year view" /></a><br /><b>Country year</b>: daily wind, solar and temperature against the 1991–2020 normal range.</td>
  </tr>
  <tr>
    <td><a href="docs/dunkel.png"><img src="docs/dunkel.png" alt="Dunkelflaute view" /></a><br /><b>Dunkelflaute</b>: calm, dark spells for an adjustable capacity mix and threshold, with hourly detail, a replay on the map and a TimesFM forecast.</td>
    <td><a href="docs/europe.png"><img src="docs/europe.png" alt="Europe together view" /></a><br /><b>Europe together</b>: how pooling wind with neighbouring countries reduces calm days, and how strongly neighbours move together.</td>
  </tr>
  <tr>
    <td><a href="docs/years.png"><img src="docs/years.png" alt="Weather years view" /></a><br /><b>Weather years</b>: every month since 1950 against normal, and winters ranked.</td>
    <td><a href="docs/future.png"><img src="docs/future.png" alt="Future climate view" /></a><br /><b>Future climate</b>: Dunkelflaute, low-wind days and capacity factors to 2100 under SSP2-4.5 and SSP5-8.5.</td>
  </tr>
</table>

### Built with

[ECharts](https://echarts.apache.org/) for the charts, [Vite](https://vite.dev/) for the build,
[ONNX Runtime Web](https://onnxruntime.ai/) for TimesFM, and Python with pandas for the data pipeline. No framework,
no backend: a static site on Cloudflare Workers, refreshed by a GitHub Action.

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
