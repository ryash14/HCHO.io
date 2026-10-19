# HCHO India Observatory

> `Geospatial exploration of atmospheric formaldehyde, fire hotspots and trajectory datasets.`

### 🏗️ System Architecture

```mermaid
%%{init: {'theme': 'dark'}}%%
flowchart TD
    N0["Processed atmospheric datasets"]
    N1["GeoJSON and time series loading"]
    N2["Year season and region filters"]
    N3["Leaflet map layers"]
    N4["Chart.js trends and comparisons"]
    N5["Interactive environmental exploration"]
    N0 --> N1
    N1 --> N2
    N2 --> N3
    N3 --> N4
    N4 --> N5
```

### 🛠️ Production Stack

JavaScript · Leaflet · Chart.js · GeoJSON · static JSON datasets · Docker

### ⚡ Key Engineering Capabilities

- Year and season controls coordinate geographic layers and charts.
- Fire hotspot and trajectory data provide additional spatial context.
- Static dataset delivery supports a small deployment without an application database.

### 🚀 Deployment and Local Setup

Run from the repository root after cloning:

```bash
git clone https://github.com/ryash14/HCHO.io.git
cd HCHO.io
docker build -t hcho-observatory .
docker run --rm -p 7860:7860 hcho-observatory
```

Open http://localhost:7860. Alternatively run `python3 -m http.server 7860`. Map tiles and browser libraries may require internet access. This repository serves processed datasets; it does not establish a reproducible upstream satellite-processing pipeline or causal attribution.

### Source Map

- [js/app.js](js/app.js)
- [processed_data/metadata.json](processed_data/metadata.json)
- [Dockerfile](Dockerfile)
