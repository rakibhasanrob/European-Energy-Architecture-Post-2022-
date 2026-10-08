// European Energy Architecture - Application Logic (Phase 1: Pre-2022 & Phase 2: Post-2022)

let map;
let markers = [];
let currentEra = 'post2022'; // Default to Post-2022 per user request, with instant toggle to Pre-2022
let labelMode = 'focus';     // 'focus' (default), 'all', 'off'
let countriesGeoJson = null;

// Convert route lists to GeoJSON FeatureCollections
function createGeoJsonRoutes(routes) {
  return {
    type: "FeatureCollection",
    features: routes.map(r => ({
      type: "Feature",
      properties: {
        id: r.id,
        name: r.name,
        mode: r.mode,
        capacity: r.capacity
      },
      geometry: {
        type: "LineString",
        coordinates: r.coordinates
      }
    }))
  };
}

// Generate point features for route waypoints / junctions
function createWaypointPoints(routes) {
  const points = [];
  routes.forEach(route => {
    route.coordinates.forEach((coord) => {
      points.push({
        type: "Feature",
        properties: { mode: route.mode, name: route.name },
        geometry: { type: "Point", coordinates: coord }
      });
    });
  });
  return {
    type: "FeatureCollection",
    features: points
  };
}

// Generate point features for on-map corridor text labels
function createCorridorAnnotations(annotations) {
  return {
    type: "FeatureCollection",
    features: annotations.map(a => ({
      type: "Feature",
      properties: {
        name: a.name,
        sub: a.sub
      },
      geometry: {
        type: "Point",
        coordinates: a.coords
      }
    }))
  };
}

// ============================================================
// BASEMAP CONFIGURATION: CartoDB Dark Matter + Offline Fallback
// ============================================================
const CARTO_DARK_STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const LOCAL_DARK_BASEMAP = {
  version: 8,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0d1117' } }
  ]
};

async function initMap() {
  setupUIEvents();

  const initialData = getActiveEnergyData(currentEra);
  renderLegend(initialData.legend, currentEra);
  updateModalContent(currentEra);

  // Fetch CartoDB Dark Matter vector style before initializing MapLibre
  let basemapStyle = LOCAL_DARK_BASEMAP;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = setTimeout(() => { if (controller) controller.abort(); }, 2500);
    const res = await fetch(CARTO_DARK_STYLE_URL, { signal: controller ? controller.signal : undefined });
    clearTimeout(timeoutId);
    if (res.ok) {
      basemapStyle = await res.json();
    }
  } catch (err) {
    console.warn('CartoDB basemap unavailable, using local dark fallback:', err);
  }

  // Guard: only build layers once, even if multiple events fire
  let layersBuilt = false;

  function buildAllLayers() {
    if (layersBuilt) return;
    layersBuilt = true;
    try {
      tuneBasemapStyle();
    } catch(e) { console.warn('tuneBasemapStyle:', e); }
    try {
      loadCountryBoundaries();
    } catch(e) { console.warn('loadCountryBoundaries:', e); }
    try {
      buildAllNetworkLayers();
    } catch(e) { console.warn('buildAllNetworkLayers:', e); }
    try {
      setEra(currentEra);
    } catch(e) { console.warn('setEra:', e); }
    try {
      addEnergyHubMarkers(getActiveEnergyData(currentEra).hubs);
    } catch(e) { console.warn('addEnergyHubMarkers:', e); }
  }

  // Initialize map with CartoDB Dark Matter (or local fallback)
  map = new maplibregl.Map({
    container: 'map',
    style: basemapStyle,
    center: [17.5, 49.5],
    zoom: 3.75,
    bearing: 0,
    pitch: 0,
    antialias: true,
    preserveDrawingBuffer: true,
    attributionControl: false
  });

  // Primary trigger
  map.on('load', buildAllLayers);

  // Backup trigger in case 'load' misfires
  map.on('styledata', function() {
    try { if (!layersBuilt && map.isStyleLoaded()) buildAllLayers(); } catch(e) {}
  });

  // Fallback trigger
  setTimeout(function() {
    if (!layersBuilt) {
      console.warn('Emergency buildAllLayers fallback triggered');
      try { buildAllLayers(); } catch(e) { console.error('Emergency build failed:', e); }
    }
  }, 4000);

  // Add markers immediately (they are HTML elements, not WebGL layers)
  addEnergyHubMarkers(initialData.hubs);
}


// Land vs Sea contrast and mute surrounding clutter
function tuneBasemapStyle() {
  try {
    if (map.getLayer('background')) {
      map.setPaintProperty('background', 'background-color', '#0d1015');
    }
    if (map.getLayer('water')) {
      map.setPaintProperty('water', 'fill-color', '#07090d');
    }
    if (map.getLayer('water_shadow')) {
      map.setPaintProperty('water_shadow', 'fill-color', '#07090d');
    }
    ['landcover', 'landuse', 'landuse_residential'].forEach(l => {
      if (map.getLayer(l)) {
        map.setPaintProperty(l, 'fill-color', '#13161c');
      }
    });

    if (map.getLayer('boundary_state')) {
      map.setLayoutProperty('boundary_state', 'visibility', 'none');
    }
    if (map.getLayer('boundary_county')) {
      map.setLayoutProperty('boundary_county', 'visibility', 'none');
    }
    if (map.getLayer('boundary_country_outline')) {
      map.setPaintProperty('boundary_country_outline', 'line-color', '#2d3340');
      map.setPaintProperty('boundary_country_outline', 'line-width', 0.85);
      map.setPaintProperty('boundary_country_outline', 'line-opacity', 0.65);
    }
    if (map.getLayer('boundary_country_inner')) {
      map.setPaintProperty('boundary_country_inner', 'line-color', '#2d3340');
      map.setPaintProperty('boundary_country_inner', 'line-width', 0.85);
      map.setPaintProperty('boundary_country_inner', 'line-opacity', 0.65);
    }
    if (map.getLayer('admin-0-boundary')) {
      map.setPaintProperty('admin-0-boundary', 'line-color', '#2d3340');
      map.setPaintProperty('admin-0-boundary', 'line-width', 0.85);
      map.setPaintProperty('admin-0-boundary', 'line-opacity', 0.65);
    }

    if (map.getLayer('place_state')) {
      map.setLayoutProperty('place_state', 'visibility', 'none');
    }

    // Tune basemap labels: keep subtle country names visible for geographical context, hide cities/roads
    const styleLayers = map.getStyle().layers;
    if (styleLayers) {
      styleLayers.forEach(l => {
        if (l.type === 'symbol') {
          const id = l.id.toLowerCase();
          if (id === 'place_country_1' || id === 'place_country_2') {
            try {
              map.setPaintProperty(l.id, 'text-color', '#5a6678');
              map.setPaintProperty(l.id, 'text-halo-color', '#0d1015');
              map.setPaintProperty(l.id, 'text-halo-width', 1.2);
              map.setPaintProperty(l.id, 'text-opacity', 0.65);
            } catch (e) {}
          } else if (
            id.includes('city') || id.includes('town') || id.includes('village') || 
            id.includes('suburb') || id.includes('capital') || id.includes('road') || 
            id.includes('poi') || id.includes('waterway') || id.includes('watername') ||
            id.includes('hamlet')
          ) {
            map.setLayoutProperty(l.id, 'visibility', 'none');
          }
        }
      });
    }
  } catch (err) {
    console.warn("Basemap tuning note:", err);
  }
}

// Load country boundaries GeoJSON (Synchronous from data.js, zero network/CORS restrictions)
function loadCountryBoundaries() {
  try {
    if (typeof EUROPEAN_COUNTRIES_GEOJSON !== 'undefined' && EUROPEAN_COUNTRIES_GEOJSON) {
      countriesGeoJson = EUROPEAN_COUNTRIES_GEOJSON;
    } else {
      console.warn("EUROPEAN_COUNTRIES_GEOJSON is not defined in data.js");
      return;
    }

    if (!map.getSource('highlight-countries')) {
      map.addSource('highlight-countries', {
        type: 'geojson',
        data: countriesGeoJson
      });
    }

    // 0. Base European landmass fill (subtle tint blending seamlessly with CartoDB basemap)
    if (!map.getLayer('base-european-landmass')) {
      map.addLayer({
        id: 'base-european-landmass',
        type: 'fill',
        source: 'highlight-countries',
        paint: {
          'fill-color': '#181c24',
          'fill-opacity': 0.35
        }
      });
    }
    if (!map.getLayer('base-european-borders')) {
      map.addLayer({
        id: 'base-european-borders',
        type: 'line',
        source: 'highlight-countries',
        paint: {
          'line-color': '#2d3340',
          'line-width': 0.85,
          'line-opacity': 0.65
        }
      });
    }

    // 1. Supplier / Sanctioned Origin (Russia) - Rose/Red Tint
    if (!map.getLayer('country-supplier-fill')) {
      map.addLayer({
        id: 'country-supplier-fill',
        type: 'fill',
        source: 'highlight-countries',
        filter: ['==', ['get', 'role_pre'], 'supplier'],
        paint: {
          'fill-color': '#be123c',
          'fill-opacity': 0.12
        }
      });
    }
    if (!map.getLayer('country-supplier-border')) {
      map.addLayer({
        id: 'country-supplier-border',
        type: 'line',
        source: 'highlight-countries',
        filter: ['==', ['get', 'role_pre'], 'supplier'],
        paint: {
          'line-color': '#f43f5e',
          'line-width': 0.85,
          'line-opacity': 0.45
        }
      });
    }

    // 2. Transit Nations (Belarus, Ukraine) - Soft Amber Tint
    map.addLayer({
      id: 'country-transit-fill',
      type: 'fill',
      source: 'highlight-countries',
      filter: ['==', ['get', 'role_pre'], 'transit'],
      paint: {
        'fill-color': '#d97706',
        'fill-opacity': 0.08
      }
    });
    map.addLayer({
      id: 'country-transit-border',
      type: 'line',
      source: 'highlight-countries',
      filter: ['==', ['get', 'role_pre'], 'transit'],
      paint: {
        'line-color': '#f59e0b',
        'line-width': 0.75,
        'line-opacity': 0.40
      }
    });

    // 3. Consumer / Destination Nations (Germany, France, Poland, Austria, Italy, etc.) - Slate-Indigo Tint
    map.addLayer({
      id: 'country-consumer-fill',
      type: 'fill',
      source: 'highlight-countries',
      filter: ['in', ['get', 'role_pre'], ['literal', ['consumer', 'baseline_consumer']]],
      paint: {
        'fill-color': '#6366f1',
        'fill-opacity': 0.12
      }
    });
    map.addLayer({
      id: 'country-consumer-border',
      type: 'line',
      source: 'highlight-countries',
      filter: ['in', ['get', 'role_pre'], ['literal', ['consumer', 'baseline_consumer']]],
      paint: {
        'line-color': '#818cf8',
        'line-width': 0.80,
        'line-opacity': 0.45
      }
    });

    // 4. Alternative Suppliers (Norway, Azerbaijan, Algeria) - Emerald Tint for Post-2022
    map.addLayer({
      id: 'country-altsupplier-fill',
      type: 'fill',
      source: 'highlight-countries',
      filter: ['==', ['get', 'role_post'], 'alt_supplier'],
      paint: {
        'fill-color': '#059669',
        'fill-opacity': 0.12
      }
    });
    map.addLayer({
      id: 'country-altsupplier-border',
      type: 'line',
      source: 'highlight-countries',
      filter: ['==', ['get', 'role_post'], 'alt_supplier'],
      paint: {
        'line-color': '#10b981',
        'line-width': 0.85,
        'line-opacity': 0.55
      }
    });
  } catch (err) {
    console.warn("Country highlights load error:", err);
  }
}

// Build all network line layers across both eras
function buildAllNetworkLayers() {
  const preRoutes = ENERGY_DATA_PRE2022.routes;
  const postRoutes = ENERGY_DATA_POST2022.routes;

  // Pre-2022 Route Sources
  map.addSource('gas-russian-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(preRoutes.filter(r => r.mode === 'gas_russian'))
  });
  map.addSource('oil-druzhba-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(preRoutes.filter(r => r.mode === 'oil_druzhba'))
  });
  map.addSource('sea-tanker-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(preRoutes.filter(r => r.mode === 'sea_tanker'))
  });
  map.addSource('gas-domestic-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(preRoutes.filter(r => r.mode === 'gas_domestic'))
  });

  // Post-2022 Route Sources
  map.addSource('severed-line-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(postRoutes.filter(r => r.mode === 'severed_line'))
  });
  map.addSource('gas-alternative-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(postRoutes.filter(r => r.mode === 'gas_alternative'))
  });
  map.addSource('lng-tanker-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(postRoutes.filter(r => r.mode === 'lng_tanker'))
  });
  map.addSource('gas-reduced-routes', {
    type: 'geojson',
    data: createGeoJsonRoutes(postRoutes.filter(r => r.mode === 'gas_reduced'))
  });

  // Dynamic Waypoint and Annotation Sources
  map.addSource('waypoints', {
    type: 'geojson',
    data: createWaypointPoints(postRoutes)
  });
  map.addSource('corridor-labels', {
    type: 'geojson',
    data: createCorridorAnnotations(ENERGY_DATA_POST2022.annotations)
  });

  // ==========================================
  // Pre-2022 Line Layers
  // ==========================================
  map.addLayer({
    id: 'gas_russian-lines',
    type: 'line',
    source: 'gas-russian-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: { 'line-color': '#38bdf8', 'line-width': 1.6, 'line-opacity': 0.90 }
  });

  map.addLayer({
    id: 'oil_druzhba-lines',
    type: 'line',
    source: 'oil-druzhba-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: { 'line-color': '#f59e0b', 'line-width': 1.7, 'line-opacity': 0.95 }
  });

  map.addLayer({
    id: 'sea_tanker-lines',
    type: 'line',
    source: 'sea-tanker-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: { 'line-color': '#2dd4bf', 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': 0.80 }
  });

  map.addLayer({
    id: 'gas_domestic-lines',
    type: 'line',
    source: 'gas-domestic-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
    paint: { 'line-color': '#8b95a5', 'line-width': 1.1, 'line-dasharray': [2, 2], 'line-opacity': 0.35 }
  });

  // ==========================================
  // Post-2022 Line Layers
  // ==========================================
  map.addLayer({
    id: 'severed_line-lines',
    type: 'line',
    source: 'severed-line-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'visible' },
    paint: { 'line-color': '#ef4444', 'line-width': 1.8, 'line-dasharray': [3, 2], 'line-opacity': 0.85 }
  });

  map.addLayer({
    id: 'gas_alternative-lines',
    type: 'line',
    source: 'gas-alternative-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'visible' },
    paint: { 'line-color': '#10b981', 'line-width': 1.8, 'line-opacity': 0.95 }
  });

  map.addLayer({
    id: 'lng_tanker-lines',
    type: 'line',
    source: 'lng-tanker-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'visible' },
    paint: { 'line-color': '#06b6d4', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.85 }
  });

  map.addLayer({
    id: 'gas_reduced-lines',
    type: 'line',
    source: 'gas-reduced-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'visible' },
    paint: { 'line-color': '#64748b', 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.40 }
  });

  // Waypoint Junction Dots
  map.addLayer({
    id: 'waypoint-dots',
    type: 'circle',
    source: 'waypoints',
    paint: {
      'circle-radius': 1.8,
      'circle-color': '#ffffff',
      'circle-opacity': 0.85
    }
  });

  // Pinned On-Map Corridor Annotations (Crisp, High-Legibility Cartographic Chips)
  map.addLayer({
    id: 'corridor-labels-layer',
    type: 'symbol',
    source: 'corridor-labels',
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 8.8,
      'text-letter-spacing': 0.10,
      'text-transform': 'uppercase',
      'text-anchor': 'center',
      'text-allow-overlap': true,
      'text-ignore-placement': true
    },
    paint: {
      'text-color': '#f1f5f9',
      'text-halo-color': 'rgba(10, 11, 14, 0.94)',
      'text-halo-width': 1.4,
      'text-opacity': 0.90
    }
  });
}

// Switch between Pre-2022 and Post-2022 eras
function setEra(era) {
  currentEra = era;
  const isPost = era === 'post2022';
  const data = getActiveEnergyData(era);

  // Update body classes
  document.body.classList.remove('era-pre2022', 'era-post2022');
  document.body.classList.add(`era-${era}`);

  // Update era buttons
  const eraPreBtn = document.getElementById('eraPreBtn');
  const eraPostBtn = document.getElementById('eraPostBtn');
  if (eraPreBtn && eraPostBtn) {
    eraPreBtn.classList.toggle('active', !isPost);
    eraPostBtn.classList.toggle('active', isPost);
  }

  // Update dropdown status badge
  const badge = document.getElementById('menuStatusBadge');
  if (badge) {
    badge.innerText = data.badge;
  }

  // Update Page Title and Minimalist Map Header
  document.title = `European Energy Architecture | ${isPost ? 'Post-2022 Pivot' : 'Pre-2022 Corridors'}`;
  const headerSubtitle = document.getElementById('mapHeaderSubtitle');
  if (headerSubtitle) {
    headerSubtitle.innerText = isPost
      ? "Post-2022 Pivot: Severed Russian Corridors & Global LNG Bridge"
      : "Pre-2022 Architecture: Russian Pipeline Dependency";
  }

  // Render Dynamic Legend
  renderLegend(data.legend, era);

  // Update Info Modal text
  updateModalContent(era);

  // Re-render Hub Markers
  if (map) {
    addEnergyHubMarkers(data.hubs);
  }

  // If map WebGL style is not ready yet, return (layer updates will run on style ready)
  if (!map || !map.isStyleLoaded || !map.isStyleLoaded()) return;

  // Update line layer visibilities and reset opacities
  const preLayerDefaults = {
    'gas_russian-lines': 0.90,
    'oil_druzhba-lines': 0.95,
    'sea_tanker-lines': 0.80,
    'gas_domestic-lines': 0.35
  };
  const postLayerDefaults = {
    'severed_line-lines': 0.85,
    'gas_alternative-lines': 0.95,
    'lng_tanker-lines': 0.85,
    'gas_reduced-lines': 0.40
  };

  Object.entries(preLayerDefaults).forEach(([id, op]) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', isPost ? 'none' : 'visible');
      map.setPaintProperty(id, 'line-opacity', op);
    }
  });

  Object.entries(postLayerDefaults).forEach(([id, op]) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', isPost ? 'visible' : 'none');
      map.setPaintProperty(id, 'line-opacity', op);
    }
  });

  // Update Waypoints and Annotations Data
  if (map.getSource('waypoints')) {
    map.getSource('waypoints').setData(createWaypointPoints(data.routes));
  }
  if (map.getSource('corridor-labels')) {
    map.getSource('corridor-labels').setData(createCorridorAnnotations(data.annotations));
  }

  // Update Country Highlights for the active era
  updateCountryHighlights(era);
}

// Update country highlights according to era and reset baseline opacities
function updateCountryHighlights(era) {
  if (!map.getLayer('country-supplier-fill')) return;
  const isPost = era === 'post2022';

  // Reset baseline opacities for all country layers
  const countryDefaults = {
    'country-supplier-fill': 0.12,
    'country-supplier-border': 0.45,
    'country-transit-fill': 0.08,
    'country-transit-border': 0.40,
    'country-consumer-fill': 0.12,
    'country-consumer-border': 0.45,
    'country-altsupplier-fill': 0.12,
    'country-altsupplier-border': 0.55
  };
  Object.entries(countryDefaults).forEach(([id, op]) => {
    if (map.getLayer(id)) {
      const prop = id.includes('fill') ? 'fill-opacity' : 'line-opacity';
      map.setPaintProperty(id, prop, op);
    }
  });

  const safeSetFilter = (layerId, filter) => {
    if (map && map.getLayer(layerId)) {
      map.setFilter(layerId, filter);
    }
  };

  if (isPost) {
    // Post-2022: Russia sanctioned, Norway/Azerbaijan/Algeria alternative suppliers
    safeSetFilter('country-supplier-fill', ['==', ['get', 'role_post'], 'sanctioned']);
    safeSetFilter('country-supplier-border', ['==', ['get', 'role_post'], 'sanctioned']);
    safeSetFilter('country-transit-fill', ['in', ['get', 'role_post'], ['literal', ['severed_transit', 'sanctioned_transit']]]);
    safeSetFilter('country-transit-border', ['in', ['get', 'role_post'], ['literal', ['severed_transit', 'sanctioned_transit']]]);
    safeSetFilter('country-consumer-fill', ['==', ['get', 'role_post'], 'diversified']);
    safeSetFilter('country-consumer-border', ['==', ['get', 'role_post'], 'diversified']);
    if (map.getLayer('country-altsupplier-fill')) {
      map.setLayoutProperty('country-altsupplier-fill', 'visibility', 'visible');
      map.setLayoutProperty('country-altsupplier-border', 'visibility', 'visible');
    }
  } else {
    // Pre-2022: Russian supplier basin, Belarus/Ukraine transit, European consumers (including France)
    safeSetFilter('country-supplier-fill', ['==', ['get', 'role_pre'], 'supplier']);
    safeSetFilter('country-supplier-border', ['==', ['get', 'role_pre'], 'supplier']);
    safeSetFilter('country-transit-fill', ['==', ['get', 'role_pre'], 'transit']);
    safeSetFilter('country-transit-border', ['==', ['get', 'role_pre'], 'transit']);
    safeSetFilter('country-consumer-fill', ['in', ['get', 'role_pre'], ['literal', ['consumer', 'baseline_consumer']]]);
    safeSetFilter('country-consumer-border', ['in', ['get', 'role_pre'], ['literal', ['consumer', 'baseline_consumer']]]);
    if (map.getLayer('country-altsupplier-fill')) {
      map.setLayoutProperty('country-altsupplier-fill', 'visibility', 'none');
      map.setLayoutProperty('country-altsupplier-border', 'visibility', 'none');
    }
  }
}

// Add Terminal & Hub Markers (Drift-Free, Math-Anchored, Tiered Hierarchy)
function addEnergyHubMarkers(hubs) {
  markers.forEach(m => m.remove());
  markers = [];

  const icons = {
    pipeline: `<svg viewBox="0 0 24 24"><path d="M4 14h16M4 10h16M7 6v12M17 6v12" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
    refinery: `<svg viewBox="0 0 24 24"><path d="M4 21V9l5-4v16M14 21V5l6-2v18" stroke="currentColor" stroke-width="1.8" fill="none"/><line x1="2" y1="21" x2="22" y2="21" stroke="currentColor" stroke-width="2"/></svg>`,
    ship: `<svg viewBox="0 0 24 24"><path d="M2 18l3-7h14l3 7H2zM7 11V6h4v5M13 11V4h4v7" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>`,
    lng: `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="7" rx="8" ry="3.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M4 7v10c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V7" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>`,
    severed: `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="#ef4444" stroke-width="1.8" fill="none"/></svg>`
  };

  Object.values(hubs).forEach(hub => {
    const isHero = hub.tier === 'hero';
    const isGas = hub.icon === 'pipeline';
    const isOil = hub.icon === 'refinery';
    const isSea = hub.icon === 'ship';
    const isLng = hub.icon === 'lng';
    const isSevered = hub.icon === 'severed';
    const pos = hub.pos || 'top';
    const el = document.createElement('div');
    el.className = `hub-node pos-${pos} ${isHero ? 'hero' : 'sub'} ${isGas ? 'gas' : ''} ${isOil ? 'oil' : ''} ${isSea ? 'sea' : ''} ${isLng ? 'lng' : ''} ${isSevered ? 'severed' : ''} hub-${hub.id}`;
    el.setAttribute('data-id', hub.id);
    el.setAttribute('data-tier', hub.tier || 'sub');
    el.title = `${hub.name} (${hub.role})`;

    el.innerHTML = `
      <div class="hub-pill">
        <span class="hub-name">${hub.name}</span>
        <span class="hub-sub">${hub.subtitle || hub.role}</span>
      </div>
      <div class="hub-medallion">
        ${icons[hub.icon] || icons.pipeline}
      </div>
      <div class="hub-dot"></div>
    `;

    el.addEventListener('click', () => {
      map.flyTo({
        center: hub.coords,
        zoom: Math.max(map.getZoom(), 5.2),
        speed: 1.1
      });
    });

    // CENTER ANCHOR: Zero geographic drift on zoom! Math-locked to exact lat/lng!
    const marker = new maplibregl.Marker({
      element: el,
      anchor: 'center'
    })
      .setLngLat(hub.coords)
      .addTo(map);

    markers.push(marker);
  });

  // Re-apply active label mode
  setLabelMode(labelMode);
}

// Render dynamic legend based on active era (Corridors & Country Alignment)
function renderLegend(legendData, era) {
  const container = document.getElementById('legendItems');
  const title = document.getElementById('legendTitle');
  if (!container) return;

  const isPost = era === 'post2022';
  if (title) {
    title.innerText = isPost ? "Post-2022 Architecture" : "Pre-2022 Russian Corridors";
  }

  container.innerHTML = '';

  // Extract corridors and countries (support both object and legacy array)
  const corridors = Array.isArray(legendData) ? legendData : (legendData?.corridors || []);
  const countries = Array.isArray(legendData) ? [] : (legendData?.countries || []);

  // 1. Corridors & Shipping Section
  if (corridors.length > 0) {
    const secTitle = document.createElement('div');
    secTitle.className = 'legend-section-title';
    secTitle.innerText = 'Corridors & Shipping';
    container.appendChild(secTitle);

    corridors.forEach(item => {
      const itemEl = document.createElement('div');
      itemEl.className = 'legend-item';
      itemEl.id = `legend-${item.id}`;
      itemEl.title = `Click to toggle ${item.label}`;
      itemEl.innerHTML = `
        <div class="legend-pill ${item.pillClass}"></div>
        <span class="legend-label">${item.label}</span>
      `;

      // Interactive toggle to dim/highlight line layer
      itemEl.addEventListener('click', () => {
        const lineLayer = `${item.id}-lines`;
        if (!map.getLayer(lineLayer)) return;
        const curOpacity = map.getPaintProperty(lineLayer, 'line-opacity');
        const defaultOp = (item.id === 'gas_domestic' || item.id === 'gas_reduced') ? 0.40 : 0.90;
        const newOpacity = curOpacity > 0.25 ? 0.08 : defaultOp;

        map.setPaintProperty(lineLayer, 'line-opacity', newOpacity);
        itemEl.classList.toggle('dimmed', newOpacity < 0.25);
      });

      container.appendChild(itemEl);
    });
  }

  // 2. Country Alignment Section
  if (countries.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'legend-divider';
    container.appendChild(divider);

    const secTitle = document.createElement('div');
    secTitle.className = 'legend-section-title';
    secTitle.innerText = 'Country Alignment';
    container.appendChild(secTitle);

    countries.forEach(item => {
      const itemEl = document.createElement('div');
      itemEl.className = 'legend-item';
      itemEl.id = `legend-${item.id}`;
      itemEl.title = `Click to toggle ${item.label}`;
      itemEl.innerHTML = `
        <div class="legend-swatch ${item.swatchClass}"></div>
        <span class="legend-label">${item.label}</span>
      `;

      // Interactive toggle to dim/highlight country fill and border
      itemEl.addEventListener('click', () => {
        const isDimmed = itemEl.classList.toggle('dimmed');
        const layers = item.layers || [];
        layers.forEach(layerId => {
          if (!map.getLayer(layerId)) return;
          if (layerId.includes('fill')) {
            const baseOp = layerId.includes('transit') ? 0.08 : 0.12;
            map.setPaintProperty(layerId, 'fill-opacity', isDimmed ? 0.012 : baseOp);
          } else if (layerId.includes('border')) {
            const baseOp = layerId.includes('transit') ? 0.40 : (layerId.includes('altsupplier') ? 0.55 : 0.50);
            map.setPaintProperty(layerId, 'line-opacity', isDimmed ? 0.05 : baseOp);
          }
        });
      });

      container.appendChild(itemEl);
    });
  }
}

// Set active label density mode ('focus', 'all', 'off')
function setLabelMode(mode) {
  labelMode = mode;
  document.body.classList.remove('mode-focus', 'mode-all', 'mode-off', 'hide-labels');
  document.body.classList.add(`mode-${mode}`);

  // Update segmented control buttons
  const segBtns = document.querySelectorAll('.label-control .seg-btn');
  segBtns.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });

  // Toggle on-map corridor annotations layer
  if (map && map.isStyleLoaded && map.isStyleLoaded() && map.getLayer('corridor-labels-layer')) {
    map.setLayoutProperty('corridor-labels-layer', 'visibility', mode === 'off' ? 'none' : 'visible');
  }
}

// Cycle between label modes: Focus -> All -> Off -> Focus
function cycleLabelMode() {
  const modes = ['focus', 'all', 'off'];
  const nextIdx = (modes.indexOf(labelMode) + 1) % modes.length;
  setLabelMode(modes[nextIdx]);
}

// Toggle era between pre2022 and post2022
function toggleEra() {
  const nextEra = currentEra === 'pre2022' ? 'post2022' : 'pre2022';
  setEra(nextEra);
}

// Update modal content depending on era
function updateModalContent(era) {
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  if (!modalTitle || !modalBody) return;

  if (era === 'post2022') {
    modalTitle.innerText = "Post-2022 European Energy Diversification";
    modalBody.innerHTML = `
      <p>
        Following the February 2022 invasion of Ukraine and subsequent weaponization and sabotage of Baltic gas infrastructure, Europe executed the most rapid energy realignment in modern history.
      </p>
      <p>
        <strong>Key Structural Realignment:</strong><br>
        • <strong>Severed Russian Corridors:</strong> Nord Stream 1 & 2 severed by subsea explosions in September 2022; Yamal–Europe nationalized and reversed; Druzhba North crude embargoed by Germany & Poland; Ukraine transit restricted to a minimal ~14 bcm/y.<br>
        • <strong>LNG Import Influx:</strong> Germany deployed emergency FSRUs starting at Wilhelmshaven, Brunsbüttel, and Lubmin. Atlantic LNG carriers from the US and Qatar surge into Rotterdam (Gate), Dunkirk, Świnoujście, and Alexandroupolis.<br>
        • <strong>Baltic Pipe:</strong> 10 bcm/y pipeline inaugurated in Sept 2022 linking Norwegian North Sea fields directly to Poland via Denmark.<br>
        • <strong>Southern Gas Corridor:</strong> Caspian natural gas via TANAP and TAP delivers 10+ bcm/y through Turkey and Greece into Melendugno, Italy.<br>
        • <strong>Norway & Algeria Backbone:</strong> Norway became Europe's primary natural gas supplier (>120 bcm/y), alongside maximized TransMed flows into Italy.
      </p>
    `;
  } else {
    modalTitle.innerText = "Pre-2022 European Energy Architecture";
    modalBody.innerHTML = `
      <p>
        Prior to 2022, Europe imported over 155 billion m³ of Russian natural gas annually alongside 2.2 million bpd of crude oil, channeled through dedicated subsea and overland pipeline networks and maritime export hubs.
      </p>
      <p>
        <strong>Key Corridors:</strong><br>
        • <strong>Nord Stream 1 & 2:</strong> Subsea Baltic arteries with 110 bcm/y combined capacity landing in Lubmin, Germany.<br>
        • <strong>Yamal–Europe:</strong> 33 bcm/y overland corridor traversing Belarus and Poland into Germany at Mallnow.<br>
        • <strong>Brotherhood / Ukrainian Transit:</strong> Siberian gas channeled through Sudzha and Ukraine into Austria's central Baumgarten hub.<br>
        • <strong>Druzhba Pipeline:</strong> The crude oil backbone supplying key refineries in Schwedt (Germany), Leuna, Bratislava, and Százhalombatta.<br>
        • <strong>Novorossiysk Terminal:</strong> Russia's dominant Black Sea crude export gateway dispatching tankers through the Bosporus to Trieste and Mediterranean refineries.
      </p>
    `;
  }
}

function setupUIEvents() {
  // Era segmented control buttons
  const eraPreBtn = document.getElementById('eraPreBtn');
  const eraPostBtn = document.getElementById('eraPostBtn');
  if (eraPreBtn) eraPreBtn.addEventListener('click', () => setEra('pre2022'));
  if (eraPostBtn) eraPostBtn.addEventListener('click', () => setEra('post2022'));

  // Label density segmented control buttons
  const labelBtns = document.querySelectorAll('.label-control .seg-btn');
  labelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      if (mode) setLabelMode(mode);
    });
  });

  // Three-Dots Menu Dropdown
  const menuDotsBtn = document.getElementById('menuDotsBtn');
  const menuDropdown = document.getElementById('menuDropdown');
  const menuToggleEraBtn = document.getElementById('menuToggleEraBtn');
  const menuAboutBtn = document.getElementById('menuAboutBtn');
  const infoModal = document.getElementById('infoModal');
  const closeModalBtn = document.getElementById('closeModalBtn');

  if (menuDotsBtn && menuDropdown) {
    menuDotsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuDropdown.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
      if (!menuDropdown.contains(e.target) && e.target !== menuDotsBtn) {
        menuDropdown.classList.remove('active');
      }
    });
  }

  if (menuToggleEraBtn) {
    menuToggleEraBtn.addEventListener('click', () => {
      if (menuDropdown) menuDropdown.classList.remove('active');
      toggleEra();
    });
  }

  if (menuAboutBtn && infoModal) {
    menuAboutBtn.addEventListener('click', () => {
      if (menuDropdown) menuDropdown.classList.remove('active');
      infoModal.classList.add('active');
    });
  }

    if (closeModalBtn && infoModal) {
    closeModalBtn.addEventListener('click', () => infoModal.classList.remove('active'));
    infoModal.addEventListener('click', (e) => {
      if (e.target === infoModal) infoModal.classList.remove('active');
    });
  }

  // Export Button & Export Modal Handlers
  const menuExportHDBtn = document.getElementById('menuExportHDBtn');
  const exportModal = document.getElementById('exportModal');
  const closeExportModalBtn = document.getElementById('closeExportModalBtn');

  if (menuExportHDBtn) {
    menuExportHDBtn.addEventListener('click', () => {
      if (menuDropdown) menuDropdown.classList.remove('active');
      exportMapImage();
    });
  }

  if (closeExportModalBtn && exportModal) {
    closeExportModalBtn.addEventListener('click', () => exportModal.classList.remove('active'));
    exportModal.addEventListener('click', (e) => {
      if (e.target === exportModal) exportModal.classList.remove('active');
    });
  }

  // Keyboard shortcuts: 'E' for Era, 'L' for Labels
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'e') {
      toggleEra();
    } else if (e.key.toLowerCase() === 'l') {
      cycleLabelMode();
    }
  });
}

// Ultra-HD Map Image Export Function (Crisp, High-Resolution PNG with DOM Overlays)
async function exportMapImage() {
  const toast = document.getElementById('exportToast');
  const toastText = document.getElementById('exportToastText');
  const menuDropdown = document.getElementById('menuDropdown');
  if (menuDropdown) menuDropdown.classList.remove('active');

  // Trigger Toast
  if (toast) {
    toast.className = 'export-toast active';
    if (toastText) toastText.textContent = 'Rendering Ultra-HD Export...';
  }

  const actionBar = document.getElementById('actionBar');

  try {
    // Hide UI controls that shouldn't appear in the clean exported map
    if (actionBar) actionBar.style.display = 'none';

    // Allow browser 120ms to repaint without action bar
    await new Promise(res => setTimeout(res, 120));

    let dataUrl = null;

    if (window.htmlToImage) {
      try {
        dataUrl = await window.htmlToImage.toPng(document.body, {
          pixelRatio: 2,
          backgroundColor: '#0a0b0e',
          skipFonts: true,
          filter: (node) => {
            if (node.id === 'exportToast' || node.id === 'exportModal' || node.id === 'infoModal' || node.id === 'actionBar') {
              return false;
            }
            return true;
          }
        });
      } catch (h2iErr) {
        console.warn('html-to-image with skipFonts failed, trying standard toPng:', h2iErr);
        dataUrl = await window.htmlToImage.toPng(document.body, {
          backgroundColor: '#0a0b0e',
          filter: (node) => {
            if (node.id === 'exportToast' || node.id === 'exportModal' || node.id === 'infoModal' || node.id === 'actionBar') {
              return false;
            }
            return true;
          }
        });
      }
    }

    // Fallback: WebGL canvas toDataURL
    if (!dataUrl && map) {
      dataUrl = map.getCanvas().toDataURL('image/png');
    }

    // Restore UI action bar
    if (actionBar) actionBar.style.display = '';

    if (!dataUrl) {
      throw new Error('Unable to render map image.');
    }

    const fileName = `European_Energy_Architecture_${currentEra.toUpperCase()}_HD.png`;

    // 1. Prepare and display Export Modal with high-res preview and direct download action
    const exportModal = document.getElementById('exportModal');
    const exportPreviewImg = document.getElementById('exportPreviewImg');
    const exportDirectDownloadBtn = document.getElementById('exportDirectDownloadBtn');
    const exportOpenNewTabBtn = document.getElementById('exportOpenNewTabBtn');

    if (exportPreviewImg) exportPreviewImg.src = dataUrl;
    if (exportDirectDownloadBtn) {
      exportDirectDownloadBtn.href = dataUrl;
      exportDirectDownloadBtn.download = fileName;
    }
    if (exportOpenNewTabBtn) {
      exportOpenNewTabBtn.href = dataUrl;
    }
    if (exportModal) {
      exportModal.classList.add('active');
    }

    // 2. Direct automatic download via Data URL (preserves exact fileName and .png extension in Chromium)
    try {
      const downloadLink = document.createElement('a');
      downloadLink.href = dataUrl;
      downloadLink.download = fileName;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      setTimeout(() => {
        if (downloadLink.parentNode) {
          document.body.removeChild(downloadLink);
        }
      }, 3000);
    } catch (dlErr) {
      console.warn('Auto-download link note:', dlErr);
    }

    // Show Success Toast
    if (toast) {
      toast.className = 'export-toast active success';
      if (toastText) toastText.textContent = 'Ultra-HD PNG Export Ready!';
      setTimeout(() => toast.classList.remove('active'), 3500);
    }
  } catch (err) {
    console.error('Export error:', err);
    if (actionBar) actionBar.style.display = '';

    // Show fallback modal with WebGL canvas
    try {
      if (map) {
        const fallbackUrl = map.getCanvas().toDataURL('image/png');
        const exportModal = document.getElementById('exportModal');
        const exportPreviewImg = document.getElementById('exportPreviewImg');
        const exportDirectDownloadBtn = document.getElementById('exportDirectDownloadBtn');
        if (exportPreviewImg) exportPreviewImg.src = fallbackUrl;
        if (exportDirectDownloadBtn) {
          exportDirectDownloadBtn.href = fallbackUrl;
          exportDirectDownloadBtn.download = `European_Energy_Architecture_${currentEra}.png`;
        }
        if (exportModal) exportModal.classList.add('active');
      }
    } catch (fbErr) {
      console.error('Canvas export fallback failed:', fbErr);
    }

    if (toast) {
      toast.className = 'export-toast active error';
      if (toastText) toastText.textContent = 'Auto-download blocked: preview modal opened.';
      setTimeout(() => toast.classList.remove('active'), 4000);
    }
  }
}

// Initialize on DOM load or immediately if DOM is already parsed (vital for file:// double-click)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMap);
} else {
  initMap();
}
