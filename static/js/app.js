/* ===========================================================
   ממד בדרך – Frontend Application
   =========================================================== */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
    map: null,
    startCoords: null,   // {lat, lon}
    endCoords: null,
    startMarker: null,
    endMarker: null,
    routeLayers: [],
    shelterLayer: null,
    routeData: null,      // { fastest, safest, alternative?, shelters, safe_radius }
    safeRadius: 390,     // walking radius in metres
    circleLayer: null,
    pickMode: null,       // null | 'start' | 'end'
    abortCtrl: null,      // AbortController for in-flight route request
};

// Israel bounding box (includes West Bank & Gaza)
const IL_BOUNDS = { south: 29.45, west: 34.2, north: 33.35, east: 35.9 };

function isInBounds(lat, lon) {
    return lat >= IL_BOUNDS.south && lat <= IL_BOUNDS.north &&
           lon >= IL_BOUNDS.west && lon <= IL_BOUNDS.east;
}

function isMobile() { return window.innerWidth <= 768; }

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initControls();
    initGeocoding();
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
    S.map = L.map('map', {
        center: [31.4, 34.8],
        zoom: 8,
        zoomControl: false,
    });

    // Clean tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a> · © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19,
    }).addTo(S.map);

    L.control.zoom({ position: 'topleft' }).addTo(S.map);

    S.map.on('click', handleMapClick);
}

function handleMapClick(e) {
    const { lat, lng } = e.latlng;
    if (!S.pickMode) return; // only respond when in pick mode

    if (!isInBounds(lat, lng)) {
        toast('יש לבחור מיקום בישראל, יו"ש או עזה', 'error');
        return;
    }

    if (S.pickMode === 'start') {
        setStart(lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    } else if (S.pickMode === 'end') {
        setEnd(lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    }
    exitPickMode();

    // On mobile, re-open sidebar after picking a point
    if (isMobile()) {
        document.getElementById('sidebar').classList.remove('collapsed');
    }
}

// ---------------------------------------------------------------------------
// Map pick mode
// ---------------------------------------------------------------------------
function enterPickMode(which) {
    S.pickMode = which;
    S.map.getContainer().style.cursor = 'crosshair';
    const banner = document.getElementById('pick-banner');
    const text = document.getElementById('pick-banner-text');
    text.textContent = which === 'start'
        ? 'לחצו על המפה לבחירת נקודת מוצא'
        : 'לחצו על המפה לבחירת יעד';
    banner.classList.remove('hidden');

    // On mobile, collapse sidebar so user can tap the map
    if (isMobile()) {
        document.getElementById('sidebar').classList.add('collapsed');
    }
}

function exitPickMode() {
    S.pickMode = null;
    S.map.getContainer().style.cursor = '';
    document.getElementById('pick-banner').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Markers (start / end)
// ---------------------------------------------------------------------------
function makeMarkerIcon(type) {
    const cls = type === 'start' ? 'custom-start-marker' : 'custom-end-marker';
    const emoji = type === 'start' ? '🚗' : '🏁';
    return L.divIcon({
        className: '',
        html: `<div class="${cls}"><span>${emoji}</span></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
    });
}

function setStart(lat, lon, label) {
    S.startCoords = { lat, lon };
    document.getElementById('start-input').value = label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    if (S.startMarker) S.map.removeLayer(S.startMarker);
    S.startMarker = L.marker([lat, lon], { icon: makeMarkerIcon('start'), draggable: true })
        .addTo(S.map)
        .bindPopup('נקודת מוצא');
    S.startMarker.on('dragend', e => {
        const p = e.target.getLatLng();
        if (!isInBounds(p.lat, p.lng)) { toast('מחוץ לגבולות', 'error'); return; }
        setStart(p.lat, p.lng);
    });
}

function setEnd(lat, lon, label) {
    S.endCoords = { lat, lon };
    document.getElementById('end-input').value = label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    if (S.endMarker) S.map.removeLayer(S.endMarker);
    S.endMarker = L.marker([lat, lon], { icon: makeMarkerIcon('end'), draggable: true })
        .addTo(S.map)
        .bindPopup('יעד');
    S.endMarker.on('dragend', e => {
        const p = e.target.getLatLng();
        if (!isInBounds(p.lat, p.lng)) { toast('מחוץ לגבולות', 'error'); return; }
        setEnd(p.lat, p.lng);
    });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function initControls() {
    // Walking distance buttons
    document.querySelectorAll('.walk-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.walk-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            S.safeRadius = +btn.dataset.radius;
        });
    });

    // Find route
    document.getElementById('find-route-btn').addEventListener('click', findRoute);

    // Locate me
    document.getElementById('locate-btn').addEventListener('click', locateMe);

    // Map pick buttons
    document.getElementById('pick-start-btn').addEventListener('click', () => enterPickMode('start'));
    document.getElementById('pick-end-btn').addEventListener('click', () => enterPickMode('end'));
    document.getElementById('pick-cancel-btn').addEventListener('click', exitPickMode);

    // Swap
    document.getElementById('swap-btn').addEventListener('click', swapPoints);

    // Input focus tracking removed — now using explicit pick mode

    // Sidebar toggle (mobile)
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
    });

    // Keyboard shortcut: Enter to search
    document.getElementById('end-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') findRoute();
    });
    document.getElementById('start-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('end-input').focus();
    });

    // About modal
    const aboutModal = document.getElementById('about-modal');
    document.getElementById('about-btn').addEventListener('click', () => aboutModal.classList.remove('hidden'));
    document.getElementById('about-close').addEventListener('click', () => aboutModal.classList.add('hidden'));
    aboutModal.addEventListener('click', e => { if (e.target === aboutModal) aboutModal.classList.add('hidden'); });
}

function swapPoints() {
    const tmpCoords = S.startCoords;
    const tmpLabel = document.getElementById('start-input').value;
    if (S.endCoords) setStart(S.endCoords.lat, S.endCoords.lon, document.getElementById('end-input').value);
    else { S.startCoords = null; document.getElementById('start-input').value = ''; if (S.startMarker) { S.map.removeLayer(S.startMarker); S.startMarker = null; } }
    if (tmpCoords) setEnd(tmpCoords.lat, tmpCoords.lon, tmpLabel);
    else { S.endCoords = null; document.getElementById('end-input').value = ''; if (S.endMarker) { S.map.removeLayer(S.endMarker); S.endMarker = null; } }
}

function locateMe() {
    if (!navigator.geolocation) return toast('הדפדפן לא תומך במיקום', 'error');
    navigator.geolocation.getCurrentPosition(
        pos => {
            const { latitude: lat, longitude: lon } = pos.coords;
            if (!isInBounds(lat, lon)) { toast('המיקום שלך מחוץ לאזור הנתמך', 'error'); return; }
            setStart(lat, lon, 'המיקום שלי');
            S.map.setView([lat, lon], 14);
            toast('המיקום שלך נקבע כנקודת מוצא', 'success');
        },
        () => toast('לא ניתן לקבל מיקום', 'error'),
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ---------------------------------------------------------------------------
// Geocoding with debounce
// ---------------------------------------------------------------------------
function initGeocoding() {
    setupAutocomplete('start-input', 'start-suggestions', (r) => {
        setStart(r.lat, r.lon, r.name.split(',')[0]);
        S.map.setView([r.lat, r.lon], 14);
    });
    setupAutocomplete('end-input', 'end-suggestions', (r) => {
        setEnd(r.lat, r.lon, r.name.split(',')[0]);
        S.map.setView([r.lat, r.lon], 14);
    });
}

function setupAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    let timer = null;

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2) { list.classList.remove('open'); return; }
        timer = setTimeout(() => geocodeSearch(q, list, onSelect), 350);
    });

    // Close on outside click
    document.addEventListener('click', e => {
        if (!input.contains(e.target) && !list.contains(e.target)) {
            list.classList.remove('open');
        }
    });
}

async function geocodeSearch(query, listEl, onSelect) {
    try {
        const resp = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        if (data.error || !data.length) { listEl.classList.remove('open'); return; }
        listEl.innerHTML = data.map((r, i) =>
            `<li data-idx="${i}">${escapeHtml(r.name)}</li>`
        ).join('');
        listEl.classList.add('open');
        listEl.querySelectorAll('li').forEach((li, i) => {
            li.addEventListener('click', () => {
                onSelect(data[i]);
                listEl.classList.remove('open');
            });
        });
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function findRoute() {
    if (!S.startCoords || !S.endCoords) {
        toast('יש לבחור נקודת מוצא ויעד', 'error');
        return;
    }

    // Cancel any in-flight request so old results never paint the map
    if (S.abortCtrl) S.abortCtrl.abort();
    S.abortCtrl = new AbortController();

    showLoading();
    clearRoute();
    S.routeData = null;

    try {
        const resp = await fetch('/api/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start: S.startCoords,
                end: S.endCoords,
                safe_radius: S.safeRadius,
            }),
            signal: S.abortCtrl.signal,
        });
        const data = await resp.json();
        if (!resp.ok) {
            toast(data.error || 'שגיאה', 'error');
            return;
        }
        S.routeData = data;
        displayResults(data);
    } catch (err) {
        if (err.name === 'AbortError') return; // superseded by newer request
        toast('שגיאת רשת – נסו שנית', 'error');
    } finally {
        hideLoading();
    }
}

// ---------------------------------------------------------------------------
// Display results
// ---------------------------------------------------------------------------
function displayResults(data) {
    const { safest, shelters, safe_radius } = data;
    const route = safest;
    if (!route) { toast('לא נמצא מסלול', 'error'); return; }

    // Draw shelters
    displayShelters(shelters);

    // Draw route coloured by shelter proximity
    clearRoute();
    drawColoredRoute(route, shelters, safe_radius);

    // Re-display shelters on top
    displayShelters(shelters);

    // Show info panel
    showRouteInfo(route);

    // Fit bounds
    const coords = route.geometry.coordinates;
    const bounds = L.latLngBounds(coords.map(c => [c[1], c[0]]));
    shelters.forEach(s => bounds.extend([s.lat, s.lon]));

    const fitOpts = isMobile()
        ? { paddingTopLeft: [20, 20], paddingBottomRight: [20, 80] }
        : { padding: [40, 40] };
    S.map.fitBounds(bounds, fitOpts);

    // On mobile, collapse sidebar to reveal the map
    if (isMobile()) {
        setTimeout(() => document.getElementById('sidebar').classList.add('collapsed'), 350);
    }
}

// ---------------------------------------------------------------------------
// Draw routes
// ---------------------------------------------------------------------------

function drawColoredRoute(route, shelters, safeRadius) {
    const coords = route.geometry.coordinates;
    if (coords.length < 2) return;

    // Background stroke for contrast
    const bg = L.polyline(coords.map(c => [c[1], c[0]]), {
        color: '#1e293b', weight: 9, opacity: 0.5, lineCap: 'round',
    }).addTo(S.map);
    S.routeLayers.push(bg);

    // Coloured segments
    for (let i = 0; i < coords.length - 1; i++) {
        const mid = [(coords[i][0] + coords[i + 1][0]) / 2,
                     (coords[i][1] + coords[i + 1][1]) / 2];
        const d = nearestDist(mid[0], mid[1], shelters);
        let color;
        if (d <= safeRadius) color = '#22c55e';
        else if (d <= safeRadius * 2) color = '#f59e0b';
        else color = '#ef4444';

        const seg = L.polyline(
            [[coords[i][1], coords[i][0]], [coords[i + 1][1], coords[i + 1][0]]],
            { color, weight: 6, opacity: 0.9, lineCap: 'round' }
        ).addTo(S.map);
        S.routeLayers.push(seg);
    }
}

function clearRoute() {
    S.routeLayers.forEach(l => S.map.removeLayer(l));
    S.routeLayers = [];
    if (S.shelterLayer) { S.map.removeLayer(S.shelterLayer); S.shelterLayer = null; }
    if (S.circleLayer) { S.map.removeLayer(S.circleLayer); S.circleLayer = null; }
}

// ---------------------------------------------------------------------------
// Shelters
// ---------------------------------------------------------------------------
function displayShelters(shelters) {
    if (S.shelterLayer) S.map.removeLayer(S.shelterLayer);

    const cluster = L.markerClusterGroup({
        maxClusterRadius: 45,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        iconCreateFunction: (c) => {
            const count = c.getChildCount();
            let size = 'small';
            if (count > 20) size = 'large';
            else if (count > 5) size = 'medium';
            return L.divIcon({
                html: `<div><span>${count}</span></div>`,
                className: `marker-cluster marker-cluster-${size}`,
                iconSize: [36, 36],
            });
        },
    });

    const icon = L.divIcon({
        className: 'shelter-marker',
        html: '<div class="shelter-icon">🛡</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
    });

    // Coverage circles layer (behind markers)
    const safeRadius = S.routeData ? S.routeData.safe_radius : S.safeRadius;
    const circleRadius = safeRadius + 40; // slightly larger visual coverage
    const circles = L.layerGroup();
    shelters.forEach(s => {
        circles.addLayer(L.circle([s.lat, s.lon], {
            radius: circleRadius,
            color: '#22c55e',
            fillColor: '#22c55e',
            fillOpacity: 0.07,
            weight: 1,
            opacity: 0.25,
            interactive: false,
        }));
    });
    circles.addTo(S.map);
    S.circleLayer = circles;

    shelters.forEach(s => {
        const marker = L.marker([s.lat, s.lon], { icon })
            .bindPopup('<div class="shelter-popup"><h4>🛡️ מקלט / ממ"ד</h4></div>');
        cluster.addLayer(marker);
    });

    S.map.addLayer(cluster);
    S.shelterLayer = cluster;
}

// ---------------------------------------------------------------------------
// Route info panel
// ---------------------------------------------------------------------------
function showRouteInfo(route) {
    const panel = document.getElementById('route-info');
    const r = route;
    const s = r.safety;

    const barColor = s.score >= 70 ? '#22c55e' : s.score >= 40 ? '#f59e0b' : '#ef4444';
    const scoreLabel = s.score >= 70 ? 'בטוח' : s.score >= 40 ? 'בינוני' : 'פחות בטוח';
    const avgWalkDist = Math.round(s.avg_distance);

    panel.innerHTML = `
        <h3>📊 מסלול</h3>
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${formatDist(r.distance)}</div>
                <div class="stat-label">מרחק</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatTime(r.duration)}</div>
                <div class="stat-label">זמן נסיעה</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${s.shelter_count}</div>
                <div class="stat-label">מקלטים בטווח</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${s.coverage}%</div>
                <div class="stat-label">כיסוי בטוח</div>
            </div>
        </div>
        <div style="margin-top:6px">
            <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:3px">
                <span>ציון בטיחות</span>
                <span style="color:${barColor};font-weight:600">${s.score} – ${scoreLabel}</span>
            </div>
            <div class="safety-bar-bg">
                <div class="safety-bar-fill" style="width:${s.score}%;background:${barColor}"></div>
            </div>
        </div>
        <div style="font-size:.78rem;color:var(--clr-text2);margin-top:4px">
            מרחק ממוצע למקלט: ${formatDist(avgWalkDist)} · קטע ארוך ללא מקלט: ${formatDist(s.max_gap)}
        </div>
        <button class="gmaps-btn" onclick="openInGoogleMaps()">🗺️ פתח ב-Google Maps</button>
    `;
    panel.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Google Maps integration
// ---------------------------------------------------------------------------
function openInGoogleMaps() {
    if (!S.startCoords || !S.endCoords) return;
    const origin = `${S.startCoords.lat},${S.startCoords.lon}`;
    const dest = `${S.endCoords.lat},${S.endCoords.lon}`;

    let waypointsStr = '';
    if (S.routeData) {
        const route = S.routeData.safest;
        const coords = route.geometry.coordinates;
        if (coords.length > 10) {
            const step = Math.floor(coords.length / 4);
            const wps = [coords[step], coords[step * 2], coords[step * 3]]
                .map(c => `${c[1]},${c[0]}`);
            waypointsStr = `&waypoints=${wps.join('|')}`;
        }
    }

    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving${waypointsStr}`;
    window.open(url, '_blank', 'noopener');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function nearestDist(lon, lat, shelters) {
    let best = Infinity;
    for (const s of shelters) {
        const d = haversineFront(lon, lat, s.lon, s.lat);
        if (d < best) best = d;
    }
    return best;
}

function haversineFront(lon1, lat1, lon2, lat2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function formatDist(m) {
    if (m >= 1000) return (m / 1000).toFixed(1) + ' ק"מ';
    return Math.round(m) + ' מ\'';
}

function formatTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.ceil((sec % 3600) / 60);
    if (h > 0) return `${h} שעות ${m} דק'`;
    return `${m} דק'`;
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Loading & Toast
// ---------------------------------------------------------------------------
function showLoading() { document.getElementById('loading').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading').classList.add('hidden'); }

function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3500);
}
