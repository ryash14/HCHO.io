/**
 * HCHO India Observatory — Main Application v3.1
 * ================================================
 * Premium dashboard with Chart.js, animated wind particles, fire density grid,
 * multi-state HCHO selection, collapsible sidebar, bottom chart panel with tabs.
 *
 * Dependencies: Leaflet 1.9+, Chart.js 4+
 */

// ─── State ──────────────────────────────────────────────────────────────────
const S = {
  year: '2024',
  season: 'Annual',
  sidebarOpen: true,
  panelOpen: false,
  activeTab: 'trends',
  online: false,
  selectedStates: [],

  // Map
  map: null,
  basemap: null,
  basemapKey: 'dark',

  // Layers
  layers: {
    hcho: null, india: null, states: null,
    hotspots: null, persistent: null, fires: null,
    hysplit: null, core: null, pixelMarker: null,
    wind: null, stateHighlight: null, stateMask: null,
  },

  // Wind animation
  windAnimFrame: null,
  windParticles: [],

  // Cache
  cache: { metadata: null, geojson: {}, stats: null, timeseries: {} },

  // Charts
  charts: {},
  nearbyCharts: [],

  // Raster bounds
  rasterBounds: [[6.74, 68.18], [37.08, 97.42]],
};

const BASEMAPS = {
  dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attr: '&copy; OSM &copy; CARTO' },
  light: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attr: '&copy; OSM &copy; CARTO' },
  topo: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attr: '&copy; OpenTopoMap' },
  streets: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap' },
};

// Chart.js defaults
Chart.defaults.font.family = "'JetBrains Mono', 'IBM Plex Mono', monospace";
Chart.defaults.font.size = 13;
Chart.defaults.color = '#e8edf4';
Chart.defaults.plugins.legend.display = false;
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.elements.line.tension = 0.35;
Chart.defaults.elements.line.borderWidth = 3; // Make lines pop


// ─── Initialization ────────────────────────────────────────────────────────

async function init() {
  setLoaderMsg('Initializing map engine…');
  initMap();
  initSidebar();
  initPanel();
  initKeys();

  setLoaderMsg('Mocking serverless connection…');
  await checkServer();

  setLoaderMsg('Loading geospatial data…');
  try {
    if (S.online) {
      const [metaResp, statsResp] = await Promise.all([
        safeFetch('/processed_data/metadata.json'),
        safeFetch('/processed_data/stats_summary.json'),
      ]);
      if (metaResp) S.cache.metadata = await metaResp.json();
      if (statsResp) S.cache.stats = await statsResp.json();
    }

    await Promise.all([
      loadHCHOOverlay(),
      loadIndiaBoundary(),
    ]);

    updateBadge();
    updateStats();
    updateLegend();

    // Build chart data (trends/fire tabs)
    buildTrendCharts();
    loadCorrelation();

    // Populate state dropdown
    populateStateDropdown();

  } catch (err) {
    console.error('Init error:', err);
  }

  // Dismiss loader
  setTimeout(() => {
    document.getElementById('loader').classList.add('done');
    setTimeout(() => document.getElementById('loader').style.display = 'none', 700);
  }, 300);
}

function setLoaderMsg(t) { const el = document.getElementById('lmsg'); if (el) el.textContent = t; }


// ─── Server Health ──────────────────────────────────────────────────────────

async function checkServer() {
  S.online = true;
  document.getElementById('server-dot').className = 'status-dot online';
  document.getElementById('server-status').textContent = 'Static Serverless Mode';
  document.getElementById('sv-server').textContent = 'STATIC (ONLINE)';
}

async function safeFetch(url, opts) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    return r.ok ? r : null;
  } catch (_) { return null; }
}


// ─── Map ────────────────────────────────────────────────────────────────────

function initMap() {
  S.map = L.map('map', {
    center: [22.5, 79.0], zoom: 5, minZoom: 4, maxZoom: 12,
    zoomControl: true, attributionControl: true,
  });

  S.basemap = L.tileLayer(BASEMAPS.dark.url, {
    attribution: BASEMAPS.dark.attr, subdomains: 'abcd', maxZoom: 19,
  }).addTo(S.map);

  S.map.on('click', onMapClick);
  S.map.on('mousemove', e => {
    document.getElementById('coords-ov').textContent =
      `${e.latlng.lat.toFixed(3)}°N, ${e.latlng.lng.toFixed(3)}°E`;
    document.getElementById('sb-cursor-lat').textContent = e.latlng.lat.toFixed(3);
    document.getElementById('sb-cursor-lon').textContent = e.latlng.lng.toFixed(3);
  });
}

function switchBasemap(btn) {
  const key = btn.dataset.bm;
  switchBasemapByKey(key);
}

function switchBasemapByKey(key) {
  if (key === S.basemapKey || !BASEMAPS[key]) return;
  S.basemapKey = key;
  S.map.removeLayer(S.basemap);
  S.basemap = L.tileLayer(BASEMAPS[key].url, {
    attribution: BASEMAPS[key].attr, subdomains: 'abcd', maxZoom: 19,
  }).addTo(S.map);
  
  // Bring masks to front if they exist
  if (S.layers.stateMask) S.layers.stateMask.bringToFront();
  
  document.querySelectorAll('.bm-btn').forEach(b => b.classList.toggle('on', b.dataset.bm === key));
}


// ─── Layers ─────────────────────────────────────────────────────────────────

async function loadHCHOOverlay() {
  const key = `${S.year}_${S.season}`;
  const url = `/processed_data/rasters/mean/Mean_HCHO_${S.year}_${S.season}.png`;

  if (S.layers.hcho) { S.map.removeLayer(S.layers.hcho); S.layers.hcho = null; }

  let bounds = S.rasterBounds;
  if (S.cache.metadata?.mean_rasters?.[key]?.bounds) {
    bounds = S.cache.metadata.mean_rasters[key].bounds;
  }
  S.rasterBounds = bounds;

  try {
    S.layers.hcho = L.imageOverlay(url + '?t=' + Date.now(), bounds, {
      opacity: 0.85, interactive: false, zIndex: 100,
    });

    if (document.getElementById('tg-hcho').checked) {
      S.layers.hcho.addTo(S.map);
    }

    // Update hotspot colors based on HCHO overlay state
    updateHotspotColors();
  } catch (err) { console.error('HCHO overlay error:', err); }
}

async function loadMonthlyOverlay(month) {
  const url = `/processed_data/rasters/monthly/HCHO_${month}.png`;
  if (S.layers.hcho) { S.map.removeLayer(S.layers.hcho); S.layers.hcho = null; }
  let bounds = S.rasterBounds;
  try {
    S.layers.hcho = L.imageOverlay(url + '?t=' + Date.now(), bounds, { opacity: 0.85, interactive: false, zIndex: 100 });
    if (document.getElementById('tg-hcho').checked) S.layers.hcho.addTo(S.map);
  } catch (err) { console.error('Monthly overlay error:', err); }
}

async function loadIndiaBoundary() {
  try {
    const resp = await safeFetch('/processed_data/geojson/india.geojson');
    if (!resp) return;
    const geojson = await resp.json();
    S.cache.geojson.india = geojson;
    S.layers.india = L.geoJSON(geojson, {
      style: { color: '#3a80b9', weight: 1.5, opacity: .6, fillColor: 'transparent', fillOpacity: 0 },
    });
    if (document.getElementById('tg-india').checked) S.layers.india.addTo(S.map);
  } catch (err) { console.error('India boundary error:', err); }
}

async function loadStatesBoundary() {
  if (S.cache.geojson.states) { showStatesLayer(); return; }
  try {
    const resp = await safeFetch('/processed_data/geojson/states.geojson');
    if (!resp) return;
    S.cache.geojson.states = await resp.json();
    showStatesLayer();
  } catch (err) { console.error('States error:', err); }
}

function showStatesLayer() {
  if (S.layers.states) S.map.removeLayer(S.layers.states);
  S.layers.states = L.geoJSON(S.cache.geojson.states, {
    style: { color: 'rgba(58,128,185,0.3)', weight: 0.8, opacity: .5, fillColor: 'transparent', fillOpacity: 0, dashArray: '3,3' },
    // No tooltips or hover effects — only shown via state dropdown selection
  });
  S.layers.states.addTo(S.map);
}


// ─── Hotspot Color Logic ────────────────────────────────────────────────────
// Yellow when HCHO overlay is on, red otherwise

function getHotspotColor() {
  const hchoOn = document.getElementById('tg-hcho')?.checked;
  return hchoOn ? '#f0c020' : '#e74c3c';
}

function updateHotspotColors() {
  const color = getHotspotColor();
  if (S.layers.hotspots) {
    S.layers.hotspots.setStyle({ color: color, fillColor: color });
  }
  updateLegend();
}

async function loadHotspots() {
  const filename = `hotspots_${S.year.toLowerCase()}_${S.season.toLowerCase()}.geojson`;
  try {
    const resp = await safeFetch(`/processed_data/geojson/hotspots/${filename}`);
    if (!resp) return;
    const geojson = await resp.json();
    if (S.layers.hotspots) S.map.removeLayer(S.layers.hotspots);
    const color = getHotspotColor();
    S.layers.hotspots = L.geoJSON(geojson, {
      style: () => ({ color: color, weight: 2, fillColor: color, fillOpacity: 0.15, dashArray: '2, 4' }),
      onEachFeature: (f, layer) => {
        layer.bindPopup(`<div style="font-family:Inter,sans-serif"><strong style="color:${color}">Hotspot</strong><br><span style="color:#5d7a96">${S.season} ${S.year}</span></div>`);
      }
    });
    if (document.getElementById('tg-hotspots').checked) S.layers.hotspots.addTo(S.map);
  } catch (err) { console.error('Hotspot load error:', err); }
}

async function loadPersistentHotspots() {
  try {
    const resp = await safeFetch(`/processed_data/geojson/hotspots/persistent_${S.season.toLowerCase()}.geojson`);
    if (!resp) return;
    const geojson = await resp.json();
    if (S.layers.persistent) S.map.removeLayer(S.layers.persistent);
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    S.layers.persistent = L.geoJSON(geojson, {
      style: () => ({ color: theme === 'light' ? '#333333' : '#ffffff', weight: 2, fillOpacity: 0.2 }),
      onEachFeature: (f, layer) => {
        layer.bindPopup(`<div style="font-family:Inter,sans-serif"><strong style="color:var(--t0)">Persistent Hotspot</strong><br><span style="color:#5d7a96">Recurrent across all years</span></div>`);
      }
    });
    if (document.getElementById('tg-persistent').checked) S.layers.persistent.addTo(S.map);
  } catch (err) { console.error('Persistent hotspot load error:', err); }
}

// ─── Fire Data (Grid Density Pixels) ────────────────────────────────────────

function getFireColor(count, maxCount) {
  const t = Math.min(count / maxCount, 1);
  if (t < 0.15) return '#fee08b';
  if (t < 0.3) return '#fdae61';
  if (t < 0.5) return '#f46d43';
  if (t < 0.75) return '#d73027';
  return '#a50026';
}

function getFireOpacity(count, maxCount) {
  return 0.45 + 0.45 * Math.min(count / maxCount, 1);
}

async function loadFireData() {
  const fireLeg = document.querySelector('.fire-density-legend');
  if (fireLeg) fireLeg.classList.remove('vis');

  if (S.layers.fires) { S.map.removeLayer(S.layers.fires); S.layers.fires = null; }

  // For Annual, load BOTH kharif and rabi
  const seasons = S.season === 'Annual' ? ['kharif', 'rabi'] : [S.season.toLowerCase()];
  const allFeatures = [];

  for (const ssn of seasons) {
    try {
      const resp = await safeFetch(`/processed_data/geojson/fires/absolute_final_${ssn}_grid.geojson`);
      if (!resp) continue;
      const geojson = await resp.json();
      if (geojson.features) allFeatures.push(...geojson.features);
    } catch (err) { console.error(`Fire data error (${ssn}):`, err); }
  }

  if (allFeatures.length === 0) return;

  // Merge duplicate grid cells (same lat/lon from kharif+rabi)
  const gridMap = {};
  allFeatures.forEach(f => {
    const key = `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`;
    if (gridMap[key]) {
      gridMap[key].count += f.properties?.count || 0;
      gridMap[key].frp += f.properties?.frp || 0;
    } else {
      gridMap[key] = {
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        count: f.properties?.count || 0,
        frp: f.properties?.frp || 0,
      };
    }
  });

  const merged = Object.values(gridMap);
  const maxCount = Math.max(...merged.map(f => f.count), 1);
  const cellSize = 0.25;
  const halfCell = cellSize / 2;

  S.layers.fires = L.layerGroup();

  merged.forEach(cell => {
    const bounds = [
      [cell.lat - halfCell, cell.lon - halfCell],
      [cell.lat + halfCell, cell.lon + halfCell],
    ];

    const rect = L.rectangle(bounds, {
      color: getFireColor(cell.count, maxCount),
      weight: 0.3,
      opacity: 0.5,
      fillColor: getFireColor(cell.count, maxCount),
      fillOpacity: getFireOpacity(cell.count, maxCount),
    });

    rect.bindPopup(`<div style="font-family:Inter,sans-serif">
      <strong style="color:#ff6600">🔥 Fire Activity</strong><br>
      <span style="color:#5d7a96">Fires: <b style="color:var(--t0)">${cell.count.toLocaleString()}</b></span><br>
      <span style="color:#5d7a96">Total FRP: <b style="color:var(--t0)">${cell.frp.toFixed(1)} MW</b></span><br>
      <span style="color:#5d7a96">Grid: <b style="color:var(--t0)">${cell.lat.toFixed(2)}°N, ${cell.lon.toFixed(2)}°E</b></span>
    </div>`);

    S.layers.fires.addLayer(rect);
  });

  if (document.getElementById('tg-fires')?.checked) {
    S.layers.fires.addTo(S.map);
    showFireDensityLegend(maxCount);
  }
}

function showFireDensityLegend(maxCount) {
  let leg = document.querySelector('.fire-density-legend');
  if (!leg) {
    leg = document.createElement('div');
    leg.className = 'fire-density-legend';
    leg.innerHTML = `
      <div class="fire-density-title">Fire Density</div>
      <div class="fire-density-bar"></div>
      <div class="fire-density-labels">
        <span>0</span>
        <span id="fire-max-label">${maxCount.toLocaleString()}</span>
      </div>
      <div style="font-size:6px; color:var(--t3); font-family:var(--mono); margin-top:1px; text-align:center">fire count / grid cell</div>
    `;
    document.getElementById('map-wrap').appendChild(leg);
  } else {
    const maxLabel = leg.querySelector('#fire-max-label');
    if (maxLabel) maxLabel.textContent = maxCount.toLocaleString();
  }
  leg.classList.add('vis');
}

async function loadHYSPLIT() {
  // Removed
}

async function loadCoreBoundary() {
  const season = S.season === 'Annual' ? 'rabi' : S.season.toLowerCase();
  try {
    let resp = await safeFetch(`/processed_data/geojson/derived_${season}_core_boundary.geojson`);
    if (!resp) resp = await safeFetch(`/processed_data/geojson/boundaries/derived_${season}_core_boundary.geojson`);
    if (!resp) return;
    const geojson = await resp.json();
    if (S.layers.core) S.map.removeLayer(S.layers.core);
    S.layers.core = L.geoJSON(geojson, {
      style: { color: '#f59e0b', weight: 2, opacity: .8, fillColor: '#f59e0b', fillOpacity: .05, dashArray: '8,4' },
    });
    S.layers.core.addTo(S.map);
  } catch (err) { console.error('Core boundary error:', err); }
}


// ─── Wind Data: Animated Flowing Particles ──────────────────────────────────

function getWindColor(speed) {
  if (speed < 2.0) return 'rgba(116,185,255,0.5)';
  if (speed < 3.5) return 'rgba(9,132,227,0.55)';
  if (speed < 5.0) return 'rgba(253,203,110,0.6)';
  if (speed < 7.0) return 'rgba(225,112,85,0.65)';
  return 'rgba(214,48,49,0.7)';
}

async function loadWindData() {
  const windLeg = document.querySelector('.wind-legend');
  if (windLeg) windLeg.classList.remove('vis');

  // Stop existing animation
  stopWindAnimation();

  if (S.layers.wind) {
    S.map.removeLayer(S.layers.wind);
    S.layers.wind = null;
  }

  if (!S.online) return;

  const year = S.year === 'All_Years' ? '2024' : S.year;
  const season = S.season;

  try {
    const resp = await safeFetch(`/processed_data/wind/wind_${year}_${season}.json`);
    if (!resp) {
      showMsg('Wind data not available for this selection');
      return;
    }
    const result = await resp.json();
    if (!result.data?.length) return;

    // Store wind field for animation
    S.windField = result.data.filter(d => d.speed > 0.5);

    // Create canvas overlay for animated wind
    createWindCanvas();
    startWindAnimation();

    if (document.getElementById('tg-wind')?.checked) {
      showWindLegend();
    }
  } catch (err) { console.error('Wind data error:', err); }
}

function createWindCanvas() {
  // Remove old canvas
  const old = document.getElementById('wind-canvas');
  if (old) old.remove();

  const mapEl = document.getElementById('map');
  const canvas = document.createElement('canvas');
  canvas.id = 'wind-canvas';
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:450;pointer-events:none;';
  mapEl.appendChild(canvas);

  // Size the canvas
  const rect = mapEl.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  // Resize on map move/zoom
  S.map.on('move zoom resize', () => {
    const r = mapEl.getBoundingClientRect();
    canvas.width = r.width;
    canvas.height = r.height;
  });
}

function startWindAnimation() {
  if (!S.windField || S.windField.length === 0) return;

  // Create particles
  const numParticles = Math.min(S.windField.length * 3, 1500);
  S.windParticles = [];

  for (let i = 0; i < numParticles; i++) {
    S.windParticles.push(createWindParticle());
  }

  function animateWind() {
    const canvas = document.getElementById('wind-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Fade old trails using destination-out to preserve map visibility behind it
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)'; // Slower fade for longer, denser trails
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    S.windParticles.forEach(p => {
      // Find nearest wind vector
      const wind = findNearestWind(p.lat, p.lon);
      if (!wind) {
        resetParticle(p);
        return;
      }

      // Convert current lat/lon to pixel
      const pt1 = S.map.latLngToContainerPoint([p.lat, p.lon]);

      // Move particle based on wind
      const speedFactor = 0.015;
      p.lon += wind.u * speedFactor;
      p.lat += wind.v * speedFactor;
      p.age++;

      // Convert new position to pixel
      const pt2 = S.map.latLngToContainerPoint([p.lat, p.lon]);

      // Draw line trail
      if (pt1.x >= 0 && pt1.x <= canvas.width && pt1.y >= 0 && pt1.y <= canvas.height) {
        ctx.beginPath();
        ctx.moveTo(pt1.x, pt1.y);
        ctx.lineTo(pt2.x, pt2.y);
        const alpha = Math.max(0, 1 - p.age / p.maxAge);
        // Make trails fully opaque and much thicker for PPT screenshots
        ctx.strokeStyle = getWindColor(wind.speed).replace(/[\d.]+\)$/, `${alpha})`);
        ctx.lineWidth = Math.min(2.5, 1.0 + wind.speed * 0.25);
        ctx.stroke();
      }

      // Reset if too old or out of bounds
      if (p.age > p.maxAge || p.lat < 6 || p.lat > 38 || p.lon < 67 || p.lon > 99) {
        resetParticle(p);
      }
    });

    S.windAnimFrame = requestAnimationFrame(animateWind);
  }

  S.windAnimFrame = requestAnimationFrame(animateWind);
}

function createWindParticle() {
  // Random position within India bounds
  return {
    lat: 6 + Math.random() * 32,
    lon: 67 + Math.random() * 32,
    age: Math.floor(Math.random() * 60),
    maxAge: 40 + Math.floor(Math.random() * 50),
  };
}

function resetParticle(p) {
  p.lat = 6 + Math.random() * 32;
  p.lon = 67 + Math.random() * 32;
  p.age = 0;
  p.maxAge = 40 + Math.floor(Math.random() * 50);
}

function findNearestWind(lat, lon) {
  if (!S.windField) return null;
  let minDist = Infinity;
  let nearest = null;
  for (const w of S.windField) {
    const d = (w.lat - lat) ** 2 + (w.lon - lon) ** 2;
    if (d < minDist) {
      minDist = d;
      nearest = w;
    }
  }
  return minDist < 25 ? nearest : null; // max ~5° search radius
}

function stopWindAnimation() {
  if (S.windAnimFrame) {
    cancelAnimationFrame(S.windAnimFrame);
    S.windAnimFrame = null;
  }
  S.windParticles = [];
  const canvas = document.getElementById('wind-canvas');
  if (canvas) canvas.remove();
}

function showWindLegend() {
  let leg = document.querySelector('.wind-legend');
  if (!leg) {
    leg = document.createElement('div');
    leg.className = 'wind-legend';
    leg.innerHTML = `
      <div class="wind-legend-title">Wind Speed (m/s)</div>
      <div class="wind-legend-row"><div class="wind-legend-arrow" style="background:#74b9ff"></div><span>&lt; 2.0 Calm</span></div>
      <div class="wind-legend-row"><div class="wind-legend-arrow" style="background:#0984e3"></div><span>2.0–3.5 Light</span></div>
      <div class="wind-legend-row"><div class="wind-legend-arrow" style="background:#fdcb6e"></div><span>3.5–5.0 Moderate</span></div>
      <div class="wind-legend-row"><div class="wind-legend-arrow" style="background:#e17055"></div><span>5.0–7.0 Strong</span></div>
      <div class="wind-legend-row"><div class="wind-legend-arrow" style="background:#d63031"></div><span>&gt; 7.0 V. Strong</span></div>
      <div style="font-size:6px;color:var(--t3);font-family:var(--mono);margin-top:3px">Animated flow lines</div>
    `;
    document.getElementById('map-wrap').appendChild(leg);
  }
  leg.classList.add('vis');
}


// ─── State-wise HCHO (Multi-select) ────────────────────────────────────────

async function populateStateDropdown() {
  const container = document.getElementById('state-select-container');
  if (!container) return;

  // Try to load states geojson
  if (!S.cache.geojson.states) {
    try {
      const resp = await safeFetch('/processed_data/geojson/states.geojson');
      if (resp) S.cache.geojson.states = await resp.json();
    } catch (_) {}
  }

  if (!S.cache.geojson.states) return;

  const names = S.cache.geojson.states.features
    .map(f => f.properties.shapeName || f.properties.NAME_1 || '')
    .filter(n => n)
    .sort();

  const unique = [...new Set(names)];

  // Build checkbox list
  container.innerHTML = `
    <div class="state-list-search">
      <input type="text" id="state-search" class="state-search-input" placeholder="Search states...">
    </div>
    <div class="state-list" id="state-list">
      <div class="state-item state-item-reset" data-state="">
        <span class="state-item-name">↩ Reset to All India</span>
      </div>
      ${unique.map(name => `
        <div class="state-item" data-state="${name}">
          <input type="checkbox" class="state-cb" value="${name}" id="sc-${name.replace(/\s+/g, '_')}">
          <label for="sc-${name.replace(/\s+/g, '_')}" class="state-item-name">${name}</label>
        </div>
      `).join('')}
    </div>
  `;

  // Search filter
  document.getElementById('state-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#state-list .state-item').forEach(item => {
      const name = item.dataset.state?.toLowerCase() || '';
      item.style.display = (!q || name.includes(q) || name === '') ? '' : 'none';
    });
  });

  // Reset button
  container.querySelector('.state-item-reset').addEventListener('click', () => {
    S.selectedStates = [];
    container.querySelectorAll('.state-cb').forEach(cb => cb.checked = false);
    onStatesSelected([]);
  });

  // Checkbox changes
  container.querySelectorAll('.state-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      S.selectedStates = [...container.querySelectorAll('.state-cb:checked')].map(c => c.value);
      onStatesSelected(S.selectedStates);
    });
  });
}

function onStatesSelected(stateNames) {
  // Remove previous highlight and mask
  if (S.layers.stateHighlight) {
    S.map.removeLayer(S.layers.stateHighlight);
    S.layers.stateHighlight = null;
  }
  if (S.layers.stateMask) {
    S.map.removeLayer(S.layers.stateMask);
    S.layers.stateMask = null;
  }

  if (!stateNames || stateNames.length === 0) {
    // Reset to all India view
    S.map.setView([22.5, 79.0], 5, { animate: true });
    return;
  }

  if (!S.cache.geojson.states) return;

  // Find matching state features
  const features = S.cache.geojson.states.features.filter(f => {
    const name = f.properties.shapeName || f.properties.NAME_1 || '';
    return stateNames.includes(name);
  });

  if (features.length === 0) return;

  // Create an inverted mask (world polygon with state holes) to hide the rest of India
  const worldCoords = [
    [90, -180], [90, 180], [-90, 180], [-90, -180]
  ];
  
  const holes = [];
  features.forEach(f => {
    if (f.geometry.type === 'Polygon') {
      holes.push(f.geometry.coordinates[0].map(c => [c[1], c[0]]));
    } else if (f.geometry.type === 'MultiPolygon') {
      f.geometry.coordinates.forEach(poly => {
        holes.push(poly[0].map(c => [c[1], c[0]]));
      });
    }
  });

  const bg = document.documentElement.getAttribute('data-theme') === 'light' ? '#eef0f3' : '#0a0d14';
  
  S.layers.stateMask = L.polygon([worldCoords, ...holes], {
    color: 'transparent',
    fillColor: bg,
    fillOpacity: 0.95,
    interactive: false,
    className: 'state-mask-layer'
  }).addTo(S.map);

  // Build a feature collection from matched states for the border highlight
  const fc = { type: 'FeatureCollection', features: features };

  S.layers.stateHighlight = L.geoJSON(fc, {
    style: {
      color: '#e08214',
      weight: 2.5,
      opacity: 1,
      fillColor: 'transparent',
      dashArray: '6,3',
    },
    onEachFeature: (f, layer) => {
      const name = f.properties.shapeName || f.properties.NAME_1 || '';
      layer.bindTooltip(name, { direction: 'center', permanent: false, className: 'state-tooltip' });
    },
  }).addTo(S.map);

  // Bring mask and highlight to front if HCHO is on
  if (S.layers.stateMask) S.layers.stateMask.bringToFront();
  if (S.layers.stateHighlight) S.layers.stateHighlight.bringToFront();
  
  // Also bring markers/wind/fires above mask (marker groups do not have bringToFront)
  if (S.layers.hotspots && typeof S.layers.hotspots.bringToFront === 'function') S.layers.hotspots.bringToFront();
  if (S.layers.fires && typeof S.layers.fires.bringToFront === 'function') S.layers.fires.bringToFront();
  if (S.layers.pixelMarker && typeof S.layers.pixelMarker.bringToFront === 'function') S.layers.pixelMarker.bringToFront();

  // Zoom to fit all selected states
  const bounds = S.layers.stateHighlight.getBounds();
  S.map.fitBounds(bounds, { padding: [40, 40], animate: true, maxZoom: 9 });
}


// ─── Map Click → Pixel Time Series ─────────────────────────────────────────

// Helpers to map click coordinates to nearest grid points in the dataset
function getNearestLat(lat) {
  let idx = Math.round((lat - 7.0) / 0.25);
  let gridLat = 7.0 + idx * 0.25;
  if (gridLat < 7.0) gridLat = 7.0;
  if (gridLat > 37.0) gridLat = 37.0;
  let s = parseFloat(gridLat.toFixed(2)).toString();
  if (!s.includes('.')) s += '.0';
  return { val: gridLat, str: s };
}

function getNearestLon(lon) {
  let idx = Math.round((lon - 68.2) / 0.25);
  let gridLon = 68.2 + idx * 0.25;
  if (gridLon < 68.2) gridLon = 68.2;
  if (gridLon > 97.5) gridLon = 97.5;
  let s = parseFloat(gridLon.toFixed(2)).toString();
  if (!s.includes('.')) s += '.0';
  return { val: gridLon, str: s };
}

// Client-side pixel data lookup
async function fetchPixelGridData(lat, lon) {
  const targetLat = getNearestLat(lat);
  const targetLon = getNearestLon(lon);
  
  try {
    const resp = await safeFetch(`/processed_data/pixels/lat_${targetLat.str}.json`);
    if (!resp) return null;
    const json = await resp.json();
    
    // Check both standard string and integer-converted keys (in case rounding differences exist)
    const ts = json[targetLon.str] || json[parseFloat(targetLon.str).toString()];
    if (!ts) return null;
    
    // Map compact [date, val] format back to full {date, value} format, reverting divided HCHO
    return ts.map(pt => ({
      date: pt[0],
      value: pt[1] * 1e15
    }));
  } catch (err) {
    console.error('Error fetching pixel grid:', err);
    return null;
  }
}

async function onMapClick(e) {
  const { lat, lng } = e.latlng;

  // Update sidebar stats
  document.getElementById('sb-cursor-lat').textContent = lat.toFixed(3);
  document.getElementById('sb-cursor-lon').textContent = lng.toFixed(3);

  // Place marker
  if (S.layers.pixelMarker) S.map.removeLayer(S.layers.pixelMarker);
  S.layers.pixelMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border:2px solid var(--ac);background:rgba(224,130,20,.2);box-shadow:0 0 12px rgba(224,130,20,.5);transform:rotate(45deg)"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    }),
  }).addTo(S.map);

  if (!S.online) {
    showMsg('Server offline — pixel queries unavailable');
    return;
  }

  // Switch to pixel tab and open panel
  switchTab('pixel');
  if (!S.panelOpen) togglePanel();

  // Show loading
  document.getElementById('pixel-ph').style.display = 'none';
  document.getElementById('cs-pixel').textContent = `Loading ${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E…`;

  try {
    const fullTs = await fetchPixelGridData(lat, lng);
    if (!fullTs || fullTs.length === 0) {
      showMsg('No valid data at this location');
      if (S.charts['c-pixel']) { S.charts['c-pixel'].data.datasets = []; S.charts['c-pixel'].update(); }
      clearNearbyGrid();
      document.getElementById('sb-pixel-val').textContent = '—';
      document.getElementById('pixel-ph').style.display = '';
      return;
    }

    // Filter by year if specific year is selected
    const filteredData = S.year === 'All_Years' 
      ? fullTs 
      : fullTs.filter(pt => pt.date.startsWith(S.year));

    if (filteredData.length === 0) {
      showMsg(`No data found for year ${S.year} at this location`);
      if (S.charts['c-pixel']) { S.charts['c-pixel'].data.datasets = []; S.charts['c-pixel'].update(); }
      clearNearbyGrid();
      document.getElementById('sb-pixel-val').textContent = '—';
      document.getElementById('pixel-ph').style.display = '';
      return;
    }

    document.getElementById('cs-pixel').textContent = `${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E`;
    const lastVal = filteredData[filteredData.length - 1].value;
    document.getElementById('sb-pixel-val').textContent = (lastVal / 1e15).toFixed(1) + '×10¹⁵';

    const chartData = {
      lat: lat,
      lon: lng,
      unit: 'molecules/cm²',
      data: filteredData
    };
    plotPixelTimeSeries(chartData);

    // Load nearby pixels
    loadNearbyPixels(lat, lng);
  } catch (err) {
    console.error('Pixel TS error:', err);
    document.getElementById('cs-pixel').textContent = 'Error loading data';
  }
}

function plotPixelTimeSeries(data) {
  const dates = data.data.map(d => d.date);
  const values = data.data.map(d => d.value / 1e15);
  const smoothed = movingAvg(values, 7);

  destroyChart('c-pixel');
  S.charts['c-pixel'] = new Chart(document.getElementById('c-pixel'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'HCHO',
          data: values,
          borderColor: '#e08214',
          backgroundColor: 'rgba(224,130,20,.06)',
          borderWidth: 1.2,
          pointRadius: 0,
          fill: true,
        },
        {
          label: '7-day avg',
          data: smoothed,
          borderColor: '#e74c3c',
          borderWidth: 1.8,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 6 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)} ×10¹⁵ mol/cm²` } },
      },
      scales: {
        x: { grid: { color: 'rgba(30,40,55,.5)' }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { grid: { color: 'rgba(30,40,55,.5)' }, title: { display: true, text: '×10¹⁵ mol/cm²', font: { size: 8 } } },
      },
    },
  });
}

async function loadNearbyPixels(lat, lon) {
  document.getElementById('nearby-ph').style.display = 'none';
  try {
    const pixel_lat = 0.25;
    const pixel_lon = 0.25;
    const yearStr = S.year === 'All_Years' ? '2024' : S.year;

    // We use indices (-1, 0, 1) to offset from the nearest grid point
    const offsets = [-1, 0, 1];
    
    const centerLatObj = getNearestLat(lat);
    const centerLonObj = getNearestLon(lon);

    // Fetch the 3 distinct latitude JSON files concurrently
    const latPromises = offsets.map(dy => {
      const targetLat = getNearestLat(centerLatObj.val + dy * 0.25);
      return safeFetch(`/processed_data/pixels/lat_${targetLat.str}.json`)
        .then(r => r ? r.json() : null)
        .catch(() => null);
    });

    const latJsons = await Promise.all(latPromises);
    const results = [];

    // Parse the grid
    offsets.forEach((dy, rowIdx) => {
      const targetLat = getNearestLat(centerLatObj.val + dy * 0.25);
      const latJson = latJsons[rowIdx];

      offsets.forEach((dx, colIdx) => {
        const targetLon = getNearestLon(centerLonObj.val + dx * 0.25);
        const offset = `(${dx},${dy})`; // Keep the same string representation for UI

        let ts = null;
        if (latJson) {
          const rawTs = latJson[targetLon.str] || latJson[parseFloat(targetLon.str).toString()];
          if (rawTs) {
            ts = rawTs
              .map(pt => ({
                date: pt[0],
                value: pt[1] * 1e15
              }))
              .filter(pt => pt.date.startsWith(yearStr));
          }
        }

        if (ts && ts.length > 0) {
          results.push({
            pixel: { lat: targetLat.val.toFixed(2), lon: targetLon.val.toFixed(2), offset: offset },
            data: ts
          });
        }
      });
    });

    if (results.length === 0) {
      document.getElementById('nearby-ph').style.display = '';
      return;
    }

    const data = {
      center: { lat: lat, lon: lon },
      radius: 1,
      pixel_size: { lat: pixel_lat, lon: pixel_lon },
      pixels: results
    };
    plotNearbyGrid(data);
  } catch (err) {
    console.error('Nearby error:', err);
    document.getElementById('nearby-ph').style.display = '';
  }
}

// ─── Nearby Grid: 3×3 Mini Sparklines ───────────────────────────────────────

function clearNearbyGrid() {
  S.nearbyCharts.forEach(c => { try { c.destroy(); } catch (_) {} });
  S.nearbyCharts = [];
  const container = document.getElementById('nearby-grid-container');
  if (container) container.innerHTML = '';
}

function plotNearbyGrid(data) {
  clearNearbyGrid();
  const container = document.getElementById('nearby-grid-container');
  if (!container) return;
  container.style.display = 'grid';

  // Store data for enlarging/download
  S.nearbyData = data;

  const gridOrder = [
    '(-1,-1)', '(0,-1)', '(1,-1)',
    '(-1,0)',  '(0,0)',  '(1,0)',
    '(-1,1)',  '(0,1)',  '(1,1)',
  ];

  const pixelMap = {};
  data.pixels.forEach(px => { pixelMap[px.pixel.offset] = px; });

  gridOrder.forEach(offset => {
    const cell = document.createElement('div');
    cell.className = 'nearby-cell' + (offset === '(0,0)' ? ' center' : '');

    const label = document.createElement('div');
    label.className = 'nearby-cell-label';

    const px = pixelMap[offset];
    if (px) {
      label.textContent = `${px.pixel.lat}°, ${px.pixel.lon}°`;
    } else {
      label.textContent = offset;
    }

    const chartDiv = document.createElement('div');
    chartDiv.className = 'nearby-cell-chart';
    const canvas = document.createElement('canvas');
    chartDiv.appendChild(canvas);

    cell.appendChild(label);
    cell.appendChild(chartDiv);
    container.appendChild(cell);

    if (px && px.data.length > 0) {
      const values = px.data.map(d => d.value / 1e15);
      const color = offset === '(0,0)' ? '#e08214' : '#5d7a96';
      const bgColor = offset === '(0,0)' ? 'rgba(224,130,20,.15)' : 'rgba(93,122,150,.08)';

      const chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: px.data.map(d => d.date),
          datasets: [{
            data: values,
            borderColor: color,
            backgroundColor: bgColor,
            borderWidth: offset === '(0,0)' ? 1.2 : 0.8,
            pointRadius: 0,
            fill: true,
            tension: 0.4,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              callbacks: {
                title: (items) => items[0]?.label || '',
                label: (ctx) => `${ctx.parsed.y?.toFixed(1)} ×10¹⁵`,
              },
              bodyFont: { size: 7 },
              titleFont: { size: 7 },
              padding: 4,
            },
          },
          scales: {
            x: { display: false },
            y: { display: false },
          },
          animation: { duration: 300 },
        },
      });
      S.nearbyCharts.push(chart);
    }
  });
}

// ─── Enlarge Nearby Grid (Fullscreen Modal) ─────────────────────────────────

function enlargeNearbyGrid() {
  if (!S.nearbyData || !S.nearbyData.pixels?.length) {
    showMsg('No nearby data to enlarge');
    return;
  }

  document.getElementById('fs-overlay').classList.add('vis');
  document.getElementById('fs-title').textContent = 'NEARBY 3×3 PIXEL GRID';
  document.getElementById('fs-sub').textContent = `${S.year} · ${S.season}`;

  const fsBody = document.getElementById('fs-body');
  // Hide the normal canvas, show a grid
  const fsCanvas = document.getElementById('fs-canvas');
  fsCanvas.style.display = 'none';

  // Remove any previous grid
  const oldGrid = fsBody.querySelector('.fs-nearby-grid');
  if (oldGrid) oldGrid.remove();

  const grid = document.createElement('div');
  grid.className = 'fs-nearby-grid';
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:8px;width:100%;height:100%;';
  fsBody.appendChild(grid);

  const gridOrder = [
    '(-1,-1)', '(0,-1)', '(1,-1)',
    '(-1,0)',  '(0,0)',  '(1,0)',
    '(-1,1)',  '(0,1)',  '(1,1)',
  ];

  const pixelMap = {};
  S.nearbyData.pixels.forEach(px => { pixelMap[px.pixel.offset] = px; });

  // Track charts for cleanup
  const fsNearbyCharts = [];

  gridOrder.forEach(offset => {
    const cell = document.createElement('div');
    const isCenter = offset === '(0,0)';
    cell.style.cssText = `
      background:var(--bg3);border:${isCenter ? '2px solid var(--ac)' : '1px solid var(--b1)'};
      border-radius:6px;overflow:hidden;display:flex;flex-direction:column;
      ${isCenter ? 'box-shadow:0 0 12px rgba(224,130,20,.3);' : ''}
    `;

    const px = pixelMap[offset];
    const label = document.createElement('div');
    label.style.cssText = `font-family:var(--mono);font-size:9px;color:${isCenter ? 'var(--ac)' : 'var(--t2)'};padding:6px 8px;text-align:center;font-weight:${isCenter ? '600' : '400'};border-bottom:1px solid var(--b1);`;
    label.textContent = px ? `${px.pixel.lat}°N, ${px.pixel.lon}°E` : offset;

    const chartDiv = document.createElement('div');
    chartDiv.style.cssText = 'flex:1;min-height:0;padding:4px;';
    const canvas = document.createElement('canvas');
    chartDiv.appendChild(canvas);

    cell.appendChild(label);
    cell.appendChild(chartDiv);
    grid.appendChild(cell);

    if (px && px.data.length > 0) {
      const values = px.data.map(d => d.value / 1e15);
      const smoothed = movingAvg(values, 7);
      const color = isCenter ? '#e08214' : '#5d7a96';

      const chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: px.data.map(d => d.date),
          datasets: [
            {
              label: 'HCHO',
              data: values,
              borderColor: color,
              backgroundColor: isCenter ? 'rgba(224,130,20,.08)' : 'rgba(93,122,150,.06)',
              borderWidth: 1,
              pointRadius: 0,
              fill: true,
              tension: 0.35,
            },
            {
              label: '7-day avg',
              data: smoothed,
              borderColor: isCenter ? '#e74c3c' : 'rgba(93,122,150,.4)',
              borderWidth: 1.2,
              pointRadius: 0,
              fill: false,
              tension: 0.35,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => `${ctx.parsed.y?.toFixed(2)} ×10¹⁵ mol/cm²`,
              },
            },
          },
          scales: {
            x: { grid: { color: 'rgba(30,40,55,.3)' }, ticks: { maxTicksLimit: 5, maxRotation: 0, font: { size: 7 } } },
            y: { grid: { color: 'rgba(30,40,55,.3)' }, ticks: { font: { size: 7 } } },
          },
        },
      });
      fsNearbyCharts.push(chart);
    }
  });

  // Store for cleanup
  S._fsNearbyCharts = fsNearbyCharts;
}

function downloadNearbyChart() {
  if (!S.nearbyData || !S.nearbyData.pixels?.length) {
    showMsg('No nearby data to download');
    return;
  }

  // Create a large composite canvas
  const compositeCanvas = document.createElement('canvas');
  const cellW = 600, cellH = 300;
  const padding = 24;
  const headerH = 70;
  compositeCanvas.width = 3 * cellW + 4 * padding;
  compositeCanvas.height = 3 * cellH + 4 * padding + headerH;
  const ctx = compositeCanvas.getContext('2d');

  // Dark background
  ctx.fillStyle = '#0f1419';
  ctx.fillRect(0, 0, compositeCanvas.width, compositeCanvas.height);

  // Title
  ctx.fillStyle = '#e8edf4';
  ctx.font = 'bold 24px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.fillText('3×3 Nearby Pixel Comparison', compositeCanvas.width / 2, 35);
  ctx.fillStyle = '#5d7a96';
  ctx.font = '16px JetBrains Mono';
  ctx.fillText(`${S.year} · ${S.season}  |  Values in ×10¹⁵ mol/cm²`, compositeCanvas.width / 2, 60);

  const gridOrder = [
    '(-1,-1)', '(0,-1)', '(1,-1)',
    '(-1,0)',  '(0,0)',  '(1,0)',
    '(-1,1)',  '(0,1)',  '(1,1)',
  ];

  const pixelMap = {};
  S.nearbyData.pixels.forEach(px => { pixelMap[px.pixel.offset] = px; });

  // Draw each cell as a proper chart
  gridOrder.forEach((offset, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const x = padding + col * (cellW + padding);
    const y = headerH + padding + row * (cellH + padding);

    // Cell background
    const isCenter = offset === '(0,0)';
    ctx.fillStyle = isCenter ? '#1a1e24' : '#141820';
    ctx.strokeStyle = isCenter ? '#e08214' : '#1a2538';
    ctx.lineWidth = isCenter ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(x, y, cellW, cellH, 8);
    ctx.fill();
    ctx.stroke();

    // Label
    const px = pixelMap[offset];
    ctx.fillStyle = isCenter ? '#e08214' : '#5d7a96';
    ctx.font = `${isCenter ? 'bold' : ''} 13px JetBrains Mono`;
    ctx.textAlign = 'center';
    ctx.fillText(px ? `${px.pixel.lat}°N, ${px.pixel.lon}°E` : offset, x + cellW / 2, y + 20);

    // Draw sparkline
    if (px && px.data.length > 0) {
      const values = px.data.map(d => d.value / 1e15);
      const minV = Math.min(...values.filter(v => v > 0));
      const maxV = Math.max(...values);
      const chartX = x + 50;
      const chartY = y + 35;
      const chartW = cellW - 70;
      const chartH = cellH - 60;

      // Grid lines
      ctx.strokeStyle = 'rgba(30,40,55,.5)';
      ctx.lineWidth = 0.5;
      for (let g = 0; g < 4; g++) {
        const gy = chartY + chartH - (g / 3) * chartH;
        ctx.beginPath();
        ctx.moveTo(chartX, gy);
        ctx.lineTo(chartX + chartW, gy);
        ctx.stroke();

        // Y labels
        const val = minV + (g / 3) * (maxV - minV);
        ctx.fillStyle = '#6b8aab';
        ctx.font = '10px JetBrains Mono';
        ctx.textAlign = 'right';
        ctx.fillText(val.toFixed(1), chartX - 6, gy + 4);
      }

      // X labels (dates)
      ctx.fillStyle = '#4b6178';
      ctx.font = '9px JetBrains Mono';
      ctx.textAlign = 'center';
      const step = Math.max(1, Math.floor(values.length / 5));
      px.data.forEach((d, j) => {
        if (j % step === 0 || j === values.length - 1) {
          const px2 = chartX + (j / (values.length - 1)) * chartW;
          ctx.fillText(d.date.substring(5), px2, chartY + chartH + 14); // MM-DD
        }
      });

      // Line
      ctx.beginPath();
      ctx.strokeStyle = isCenter ? '#e08214' : '#739bbd';
      ctx.lineWidth = isCenter ? 2 : 1.2;
      values.forEach((v, j) => {
        const px2 = chartX + (j / (values.length - 1)) * chartW;
        const py = chartY + chartH - ((v - minV) / (maxV - minV || 1)) * chartH;
        if (j === 0) ctx.moveTo(px2, py);
        else ctx.lineTo(px2, py);
      });
      ctx.stroke();

      // Fill
      ctx.lineTo(chartX + chartW, chartY + chartH);
      ctx.lineTo(chartX, chartY + chartH);
      ctx.closePath();
      ctx.fillStyle = isCenter ? 'rgba(224,130,20,.1)' : 'rgba(93,122,150,.07)';
      ctx.fill();
    }
  });

  const url = compositeCanvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `hcho_nearby_3x3_HD_${S.year}_${S.season}.png`;
  a.click();
}


// ─── Trend Charts ───────────────────────────────────────────────────────────

function buildTrendCharts() {
  const stats = S.cache.stats;
  if (!stats) return;

  const years = ['2019', '2020', '2021', '2022', '2023', '2024', '2025'];

  // --- Hotspot Count Chart ---
  const annualCounts = years.map(y => stats.hotspots?.[`Hotspots_${y}_Annual`] || stats.hotspots?.[`hotspots_${y}_annual`] || 0);
  destroyChart('c-hotspots');
  S.charts['c-hotspots'] = new Chart(document.getElementById('c-hotspots'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'Hotspots',
        data: annualCounts,
        backgroundColor: annualCounts.map(v => v > (Math.max(...annualCounts) * 0.7) ? 'rgba(231,76,60,.7)' : 'rgba(224,130,20,.45)'),
        borderColor: annualCounts.map(v => v > (Math.max(...annualCounts) * 0.7) ? '#e74c3c' : '#e08214'),
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      plugins: {
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.y} hotspot features` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: 'rgba(30,40,55,.5)' }, title: { display: true, text: 'Features', font: { size: 8 } } },
      },
    },
  });

  // --- Fire Activity Chart ---
  const fireKharif = stats.fires?.['Absolute_Final_Kharif']?.total_fires || stats.fires?.['absolute_final_kharif']?.total_fires || 0;
  const fireRabi = stats.fires?.['Absolute_Final_Rabi']?.total_fires || stats.fires?.['absolute_final_rabi']?.total_fires || 0;
  destroyChart('c-fires');
  S.charts['c-fires'] = new Chart(document.getElementById('c-fires'), {
    type: 'doughnut',
    data: {
      labels: ['Kharif', 'Rabi'],
      datasets: [{
        data: [fireKharif, fireRabi],
        backgroundColor: ['rgba(224,130,20,.6)', 'rgba(41,128,185,.6)'],
        borderColor: ['#e08214', '#2980b9'],
        borderWidth: 1.5,
      }],
    },
    options: {
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 8, padding: 8 } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString()} fires` } },
      },
      cutout: '55%',
    },
  });

  // --- Season Comparison Chart ---
  const kharifCounts = years.map(y => stats.hotspots?.[`Hotspots_${y}_Kharif`] || stats.hotspots?.[`hotspots_${y}_kharif`] || 0);
  const rabiCounts = years.map(y => stats.hotspots?.[`Hotspots_${y}_Rabi`] || stats.hotspots?.[`hotspots_${y}_rabi`] || 0);

  destroyChart('c-seasons');
  S.charts['c-seasons'] = new Chart(document.getElementById('c-seasons'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Kharif', data: kharifCounts, backgroundColor: 'rgba(224,130,20,.5)', borderColor: '#e08214', borderWidth: 1, borderRadius: 3 },
        { label: 'Rabi', data: rabiCounts, backgroundColor: 'rgba(41,128,185,.5)', borderColor: '#2980b9', borderWidth: 1, borderRadius: 3 },
      ],
    },
    options: {
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 6 } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: 'rgba(30,40,55,.5)' }, title: { display: true, text: 'Hotspot Features', font: { size: 8 } } },
      },
    },
  });
}


// ─── Fire–HCHO Correlation ──────────────────────────────────────────────────

async function loadCorrelation() {
  if (!S.online) return;
  const season = S.season === 'Annual' ? 'Kharif' : S.season;
  const year = S.year === 'All_Years' ? '2024' : S.year;
  const tsName = `TS_${season}_${year}`;

  document.getElementById('cs-fire').textContent = `${season} ${year}`;

  try {
    const resp = await safeFetch(`/processed_data/timeseries/${tsName}.json`);
    if (!resp) return;
    const data = await resp.json();
    plotCorrelation(data, season, year);
    plotFRPDistribution(data);
  } catch (err) { console.error('Correlation error:', err); }
}

function plotCorrelation(data, season, year) {
  const dates = data.map(d => d.date);
  const hcho = data.map(d => (d.hcho_raw || 0) / 1e15);
  const frp = data.map(d => d.total_frp_mw || 0);

  destroyChart('c-corr');
  S.charts['c-corr'] = new Chart(document.getElementById('c-corr'), {
    type: 'bar',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'FRP (MW)',
          data: frp,
          type: 'bar',
          backgroundColor: 'rgba(255,102,0,.35)',
          borderColor: '#ff6600',
          borderWidth: 0,
          yAxisID: 'y1',
          order: 2,
        },
        {
          label: 'HCHO ×10¹⁵',
          data: hcho,
          type: 'line',
          borderColor: '#e08214',
          borderWidth: 1.8,
          pointRadius: 0,
          yAxisID: 'y',
          order: 1,
          fill: false,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 6 } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
        y: { position: 'left', grid: { color: 'rgba(30,40,55,.5)' }, title: { display: true, text: 'HCHO ×10¹⁵', font: { size: 8 }, color: '#e08214' } },
        y1: { position: 'right', grid: { display: false }, title: { display: true, text: 'FRP (MW)', font: { size: 8 }, color: '#ff6600' } },
      },
    },
  });
}

function plotFRPDistribution(data) {
  const frpValues = data.map(d => d.total_frp_mw || 0).filter(v => v > 0);
  if (frpValues.length === 0) return;
  const bins = 20;
  const maxFRP = Math.max(...frpValues);
  const binSize = maxFRP / bins;
  const histogram = new Array(bins).fill(0);
  const labels = [];
  for (let i = 0; i < bins; i++) {
    labels.push(Math.round(i * binSize));
    frpValues.forEach(v => {
      const binIdx = Math.min(Math.floor(v / binSize), bins - 1);
      if (binIdx === i) histogram[i]++;
    });
  }

  destroyChart('c-frp');
  S.charts['c-frp'] = new Chart(document.getElementById('c-frp'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Days',
        data: histogram,
        backgroundColor: 'rgba(255,102,0,.4)',
        borderColor: '#ff6600',
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: {
      plugins: {
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.y} days` } },
      },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'FRP (MW)', font: { size: 8 } } },
        y: { grid: { color: 'rgba(30,40,55,.5)' }, title: { display: true, text: 'Days', font: { size: 8 } } },
      },
    },
  });
}


// ─── Events ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.season-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.season-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.season = btn.dataset.season;
    document.getElementById('sv-season').textContent = S.season;
    reloadData();
  });
});

// ─── Layer Toggle ───────────────────────────────────────────────────────────

function initSidebar() {
  const toggleMap = {
    'tg-hcho': 'hcho', 'tg-hotspots': 'hotspots', 'tg-persistent': 'persistent',
    'tg-fires': 'fires', 'tg-india': 'india',
    'tg-states': 'states', 'tg-core': 'core', 'tg-wind': 'wind'
  };

  Object.entries(toggleMap).forEach(([id, name]) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', e => {
        toggleLayer(name, e.target.checked);
        updateLegend();
        // Update hotspot colors when HCHO overlay changes
        if (name === 'hcho') updateHotspotColors();
      });
    }
  });

  document.querySelectorAll('.year-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.year-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      S.year = btn.dataset.year;
      await reloadData();
    });
  });
}

async function toggleLayer(name, visible) {
  const loaders = {
    hcho: () => { 
      if (S.layers.hcho) { visible ? S.layers.hcho.addTo(S.map) : S.map.removeLayer(S.layers.hcho); } 
      const leg = document.getElementById('hcho-legend');
      if (leg) leg.style.display = visible ? 'block' : 'none';
    },
    india: async () => { if (visible) { if (!S.layers.india) await loadIndiaBoundary(); else S.layers.india.addTo(S.map); } else if (S.layers.india) S.map.removeLayer(S.layers.india); },
    states: async () => { if (visible) await loadStatesBoundary(); else if (S.layers.states) S.map.removeLayer(S.layers.states); },
    hotspots: async () => { if (visible) await loadHotspots(); else if (S.layers.hotspots) S.map.removeLayer(S.layers.hotspots); },
    persistent: async () => { if (visible) await loadPersistentHotspots(); else if (S.layers.persistent) S.map.removeLayer(S.layers.persistent); },
    fires: async () => {
      if (visible) {
        await loadFireData();
      } else {
        if (S.layers.fires) S.map.removeLayer(S.layers.fires);
        const fireLeg = document.querySelector('.fire-density-legend');
        if (fireLeg) fireLeg.classList.remove('vis');
      }
    },
    wind: async () => {
      if (visible) {
        await loadWindData();
      } else {
        stopWindAnimation();
        const windLeg = document.querySelector('.wind-legend');
        if (windLeg) windLeg.classList.remove('vis');
      }
    },
    hysplit: async () => { if (visible) await loadHYSPLIT(); else if (S.layers.hysplit) S.map.removeLayer(S.layers.hysplit); },
    core: async () => { if (visible) await loadCoreBoundary(); else if (S.layers.core) S.map.removeLayer(S.layers.core); },
  };
  if (loaders[name]) await loaders[name]();
}

async function reloadData() {
  updateBadge();
  updateStats();
  await loadHCHOOverlay();
  loadCorrelation();
  for (const name of ['hotspots', 'persistent', 'fires', 'core', 'wind']) {
    const tg = document.getElementById(`tg-${name}`);
    if (tg?.checked) toggleLayer(name, true);
  }
}


// ─── Sidebar / Panel / Theme ────────────────────────────────────────────────

function toggleSidebar() {
  S.sidebarOpen = !S.sidebarOpen;
  document.getElementById('sb').classList.toggle('collapsed', !S.sidebarOpen);
  setTimeout(() => S.map.invalidateSize(), 250);
}

function togglePanel() {
  S.panelOpen = !S.panelOpen;
  document.getElementById('panel').classList.toggle('open', S.panelOpen);
  document.getElementById('hlbl').textContent = S.panelOpen ? '▼ Hide Charts' : '▲ Show Charts';
  setTimeout(() => {
    S.map.invalidateSize();
    Object.values(S.charts).forEach(c => { try { c.resize(); } catch (_) {} });
    S.nearbyCharts.forEach(c => { try { c.resize(); } catch (_) {} });
  }, 300);
}

function initPanel() {
  document.querySelectorAll('.ptab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.pv));
  });
}

function switchTab(key) {
  S.activeTab = key;
  document.querySelectorAll('.ptab').forEach(t => t.classList.toggle('on', t.dataset.pv === key));
  document.querySelectorAll('.pview').forEach(v => v.classList.toggle('vis', v.id === `pv-${key}`));
  setTimeout(() => {
    Object.values(S.charts).forEach(c => { try { c.resize(); } catch (_) {} });
    S.nearbyCharts.forEach(c => { try { c.resize(); } catch (_) {} });
  }, 100);
}

function toggleTheme() {
  const app = document.getElementById('app');
  const current = app.dataset.theme || 'dark';
  const theme = current === 'dark' ? 'light' : 'dark';
  
  app.dataset.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);

  // Also switch the map basemap to match
  switchBasemapByKey(theme);
  
  updateHotspotColors();
  if (S.layers.persistent) S.layers.persistent.setStyle({ color: theme === 'light' ? '#333333' : '#ffffff' });

  // Update state mask color if active
  if (S.layers.stateMask) {
    S.layers.stateMask.setStyle({ fillColor: theme === 'light' ? '#eef0f3' : '#0a0d14' });
  }

  Object.values(S.charts).forEach(c => { try { c.update(); } catch (_) {} });
}

function initKeys() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'b' || e.key === 'B') toggleSidebar();
    if (e.key === 'Escape') {
      closeFsChart();
      if (S.panelOpen) togglePanel();
    }
  });
}


// ─── Update Badge / Stats / Legend ──────────────────────────────────────────

function updateBadge() {
  const yr = S.year === 'All_Years' ? 'ALL YEARS' : S.year;
  document.getElementById('map-badge').textContent = `HCHO · ${S.season.toUpperCase()} · ${yr}`;
  document.getElementById('sv-year').textContent = yr;
  document.getElementById('sv-season').textContent = S.season;
}

function updateStats() {
  const stats = S.cache.stats;
  if (!stats) return;

  const key1 = `Hotspots_${S.year}_${S.season}`;
  const key2 = `hotspots_${S.year}_${S.season.toLowerCase()}`;
  const hsCount = stats.hotspots?.[key1] || stats.hotspots?.[key2] || '—';
  document.getElementById('sv-hotspots').textContent = hsCount;
  document.getElementById('sb-hotspot-count').textContent = hsCount;

  const season = S.season === 'Annual' ? 'Kharif' : S.season;
  const fKey1 = `Absolute_Final_${season}`;
  const fKey2 = `absolute_final_${season.toLowerCase()}`;
  const fCount = stats.fires?.[fKey1]?.grid_cells || stats.fires?.[fKey2]?.grid_cells || '—';
  document.getElementById('sv-fires').textContent = fCount;
}

function updateLegend() {
  const body = document.getElementById('leg-body');
  const hotspotColor = getHotspotColor();
  const items = [
    { id: 'tg-hcho', label: 'HCHO Column', color: '#f89441' },
    { id: 'tg-hotspots', label: 'Hotspots', color: hotspotColor },
    { id: 'tg-persistent', label: 'Persistent', color: '#9b59b6' },
    { id: 'tg-fires', label: 'Fire Density', color: '#d73027' },
    { id: 'tg-wind', label: 'Wind Flow', color: '#0984e3' },
    { id: 'tg-india', label: 'India Border', color: '#3a80b9' },
    { id: 'tg-states', label: 'States', color: 'rgba(58,128,185,0.5)' },
    { id: 'tg-core', label: 'Core Region', color: '#f59e0b' },
  ];

  body.innerHTML = items
    .filter(i => document.getElementById(i.id)?.checked)
    .map(i => `<div class="leg-row"><div class="leg-sw" style="background:${i.color}"></div>${i.label}</div>`)
    .join('');
}


// ─── Message / Export / Fullscreen ──────────────────────────────────────────

function showMsg(text) {
  const el = document.getElementById('hs-msg');
  el.textContent = text;
  el.classList.add('vis');
  setTimeout(() => el.classList.remove('vis'), 3500);
}

function downloadChart(id) {
  const chart = S.charts[id];
  if (!chart) return;
  const url = chart.toBase64Image();
  const a = document.createElement('a');
  a.href = url;
  a.download = `hcho_${id}_${S.year}_${S.season}.png`;
  a.click();
}

function fullscreenChart(id) {
  const chart = S.charts[id];
  if (!chart) return;

  const config = chart.config;
  document.getElementById('fs-overlay').classList.add('vis');
  document.getElementById('fs-title').textContent = id.replace('c-', '').toUpperCase();
  document.getElementById('fs-sub').textContent = `${S.year} · ${S.season}`;

  // Make sure canvas is visible (might be hidden from nearby grid fullscreen)
  document.getElementById('fs-canvas').style.display = '';
  const oldGrid = document.querySelector('.fs-nearby-grid');
  if (oldGrid) oldGrid.remove();

  setTimeout(() => {
    if (S.charts['fs-canvas']) { try { S.charts['fs-canvas'].destroy(); } catch (_) {} }
    S.charts['fs-canvas'] = new Chart(document.getElementById('fs-canvas'), {
      type: config.type,
      data: JSON.parse(JSON.stringify(config.data)),
      options: {
        ...config.options,
        plugins: {
          ...config.options.plugins,
          legend: { ...config.options?.plugins?.legend, display: true },
        },
      },
    });
  }, 50);
}

function closeFsChart() {
  document.getElementById('fs-overlay').classList.remove('vis');
  if (S.charts['fs-canvas']) { try { S.charts['fs-canvas'].destroy(); } catch (_) {} }

  // Cleanup nearby fullscreen charts
  if (S._fsNearbyCharts) {
    S._fsNearbyCharts.forEach(c => { try { c.destroy(); } catch (_) {} });
    S._fsNearbyCharts = null;
  }
  const oldGrid = document.querySelector('.fs-nearby-grid');
  if (oldGrid) oldGrid.remove();

  // Restore canvas visibility
  document.getElementById('fs-canvas').style.display = '';
}

function downloadFsChart() {
  // If it's a nearby grid fullscreen, use the download method
  if (S._fsNearbyCharts) {
    downloadNearbyChart();
    return;
  }
  const chart = S.charts['fs-canvas'];
  if (!chart) return;
  const url = chart.toBase64Image();
  const a = document.createElement('a');
  a.href = url;
  a.download = `hcho_chart_${S.year}_${S.season}.png`;
  a.click();
}


// ─── Utilities ──────────────────────────────────────────────────────────────

function destroyChart(id) {
  if (S.charts[id]) {
    try { S.charts[id].destroy(); } catch (_) {}
    delete S.charts[id];
  }
}

function movingAvg(arr, w) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - Math.floor(w / 2));
    const end = Math.min(arr.length, i + Math.ceil(w / 2));
    const slice = arr.slice(start, end).filter(v => v != null && !isNaN(v));
    return slice.length ? slice.reduce((a, b) => a + b) / slice.length : null;
  });
}


// ─── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
