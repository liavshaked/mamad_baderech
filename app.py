import os
import re
import time
import math
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Flask, render_template, request, jsonify
import requests
from math import radians, cos, sin, asin, sqrt

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OSRM_URL = os.environ.get("OSRM_URL", "https://router.project-osrm.org")
NOMINATIM_URL = "https://nominatim.openstreetmap.org"
GOVMAP_CATALOG_URL = "https://www.govmap.gov.il/api/layers-catalog"
GOVMAP_SHELTER_LAYER = "417"  # bombshelters layer id
USER_AGENT = "MamadBaderech/1.0 (shelter-routing-app)"
DEFAULT_SAFE_RADIUS = 300  # metres
MAX_DETOUR_SECONDS = 600   # 10 minutes max extra for safe route

# ---------------------------------------------------------------------------
# Simple in-memory cache (key → (value, timestamp))
# ---------------------------------------------------------------------------
_cache: dict = {}
CACHE_TTL = 3600  # 1 hour


def _cget(key):
    entry = _cache.get(key)
    if entry and time.time() - entry[1] < CACHE_TTL:
        return entry[0]
    return None


def _cset(key, value):
    _cache[key] = (value, time.time())


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------
def haversine(lon1, lat1, lon2, lat2):
    """Distance in metres between two (lon, lat) points."""
    lon1, lat1, lon2, lat2 = map(radians, (lon1, lat1, lon2, lat2))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 6_371_000 * 2 * asin(sqrt(a))


def _sample(coords, interval=200):
    """Yield [lon, lat] points every *interval* metres along *coords*."""
    if not coords:
        return
    yield coords[0]
    accum = 0.0
    prev = coords[0]
    for pt in coords[1:]:
        accum += haversine(prev[0], prev[1], pt[0], pt[1])
        if accum >= interval:
            yield pt
            accum = 0.0
        prev = pt
    if coords[-1] != coords[0]:
        yield coords[-1]


def _nearest(lon, lat, shelters):
    """Return distance (m) to nearest shelter."""
    best = float("inf")
    for s in shelters:
        d = haversine(lon, lat, s["lon"], s["lat"])
        if d < best:
            best = d
    return best


def _score_route(coords, shelters, safe_radius):
    """Return safety metrics dict for a route."""
    empty = dict(coverage=0, avg_distance=0, max_distance=0,
                 max_gap=0, score=0, shelter_count=0)
    if not coords or not shelters:
        return empty

    pts = list(_sample(coords))
    if not pts:
        return empty

    dists = [_nearest(p[0], p[1], shelters) for p in pts]
    in_safe = sum(1 for d in dists if d <= safe_radius)
    coverage = in_safe / len(dists) * 100
    avg_d = sum(dists) / len(dists)
    max_d = max(dists)

    # Longest consecutive unsafe stretch
    max_gap = cur = 0
    for d in dists:
        if d > safe_radius:
            cur += 200
        else:
            max_gap = max(max_gap, cur)
            cur = 0
    max_gap = max(max_gap, cur)

    # Unique shelters near the route
    nearby = set()
    for p in pts:
        for idx, s in enumerate(shelters):
            if haversine(p[0], p[1], s["lon"], s["lat"]) <= safe_radius:
                nearby.add(idx)

    sc = (coverage * 0.5
          + max(0, 100 - max_gap / 50) * 0.3
          + max(0, 100 - avg_d / 10) * 0.2)

    return dict(
        coverage=round(coverage, 1),
        avg_distance=round(avg_d),
        max_distance=round(max_d),
        max_gap=round(max_gap),
        score=round(max(0, min(100, sc)), 1),
        shelter_count=len(nearby),
    )


# ---------------------------------------------------------------------------
# Coordinate conversion helpers (WGS84 ↔ Web Mercator EPSG:3857)
# ---------------------------------------------------------------------------
def _to_3857(lon, lat):
    """Convert WGS84 (lon, lat) to Web Mercator (x, y)."""
    x = lon * 20037508.34 / 180
    y = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180)
    y = y * 20037508.34 / 180
    return x, y


def _from_3857(x, y):
    """Convert Web Mercator (x, y) to WGS84 (lon, lat)."""
    lon = x * 180 / 20037508.34
    lat = math.atan(math.exp(y * math.pi / 20037508.34)) * 360 / math.pi - 90
    return lon, lat


# ---------------------------------------------------------------------------
# Shelter fetching (GovMap API - Israeli official data)
# ---------------------------------------------------------------------------
def _fetch_shelters_along(routes_raw):
    """Fetch shelters by sampling points along the actual route geometries.

    Instead of gridding the full bounding box (which can generate 100+
    requests for long routes), we sample a point every ~5 km along each
    route alternative and query GovMap with a 5 km tolerance.
    Typical route: 10-25 queries → finishes in a few seconds.
    """
    # Build unique query points by sampling all routes
    SAMPLE_INTERVAL = 3000   # sample a point every 3 km (tighter coverage)
    TOLERANCE = 5000         # GovMap search radius in metres
    GRID_SNAP = 2500         # round to 2.5 km grid to deduplicate nearby points

    grid_cells = set()       # (snapped_x, snapped_y)
    query_points = []        # actual (x, y)

    for rt in routes_raw:
        coords = rt["geometry"]["coordinates"]
        if not coords:
            continue
        accum = 0.0
        prev = coords[0]
        # Always include the first point
        px, py = _to_3857(prev[0], prev[1])
        cell = (round(px / GRID_SNAP), round(py / GRID_SNAP))
        if cell not in grid_cells:
            grid_cells.add(cell)
            query_points.append((px, py))
        for pt in coords[1:]:
            accum += haversine(prev[0], prev[1], pt[0], pt[1])
            if accum >= SAMPLE_INTERVAL:
                px, py = _to_3857(pt[0], pt[1])
                cell = (round(px / GRID_SNAP), round(py / GRID_SNAP))
                if cell not in grid_cells:
                    grid_cells.add(cell)
                    query_points.append((px, py))
                accum = 0.0
            prev = pt
        # Always include the last point
        px, py = _to_3857(coords[-1][0], coords[-1][1])
        cell = (round(px / GRID_SNAP), round(py / GRID_SNAP))
        if cell not in grid_cells:
            grid_cells.add(cell)
            query_points.append((px, py))

    # Build a cache key from the snapped grid cells
    key = "sh:" + ";".join(f"{c[0]},{c[1]}" for c in sorted(grid_cells))
    cached = _cget(key)
    if cached is not None:
        return cached

    shelters = []
    seen_ids = set()
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}

    def _query_point(qx, qy):
        """Query GovMap for a single point; returns list of (oid, lon, lat)."""
        try:
            r = requests.post(
                f"{GOVMAP_CATALOG_URL}/entitiesByPoint",
                json={
                    "point": [qx, qy],
                    "layers": [{"layerId": GOVMAP_SHELTER_LAYER}],
                    "tolerance": TOLERANCE,
                },
                headers=headers,
                timeout=15,
            )
            if r.status_code != 200:
                return []
            results = []
            data = r.json().get("data", [])
            for group in data:
                for ent in group.get("entities", []):
                    oid = ent.get("objectId")
                    cx, cy = ent.get("centroid", [0, 0])
                    lon, lat = _from_3857(cx, cy)
                    results.append((oid, lon, lat))
            return results
        except Exception:
            return []

    # Run queries in parallel (up to 10 threads)
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_query_point, qx, qy): (qx, qy)
                   for qx, qy in query_points}
        for fut in as_completed(futures):
            for oid, lon, lat in fut.result():
                if oid not in seen_ids:
                    seen_ids.add(oid)
                    shelters.append({"lat": lat, "lon": lon})

    _cset(key, shelters)
    return shelters


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/geocode")
def geocode():
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])

    key = f"geo:{q}"
    cached = _cget(key)
    if cached is not None:
        return jsonify(cached)

    try:
        r = requests.get(
            f"{NOMINATIM_URL}/search",
            params={"q": q, "format": "json", "limit": 5,
                    "countrycodes": "il,ps", "accept-language": "he",
                    "addressdetails": 1},
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        r.raise_for_status()
        results = []
        seen_names = set()

        # Extract a house number from the user's query (e.g. "מנחם בגין 71")
        query_num_m = re.search(r'\d+', q)
        query_num = query_num_m.group(0) if query_num_m else ""

        for i in r.json():
            addr = i.get("address", {})
            display = i.get("display_name", "")
            first_seg = display.split(",")[0].strip()

            # Use house_number from addressdetails when available
            house = str(addr.get("house_number", "")).strip()
            street = addr.get("road", addr.get("pedestrian", ""))
            city = (addr.get("city") or addr.get("town")
                    or addr.get("village") or addr.get("hamlet") or "")

            # Build the label: prefer street + house_number
            if street and house:
                label = f"{street} {house}"
            elif street and query_num and query_num not in first_seg:
                # Nominatim returned a street-level result without the number
                # but the user typed a number — inject it
                label = f"{street} {query_num}"
            else:
                label = first_seg

            if label and city and city != label:
                short = f"{label}, {city}"
            elif label:
                short = label
            else:
                short = display.split(",")[0]

            # Deduplicate identical display names
            if short in seen_names:
                continue
            seen_names.add(short)

            results.append({
                "name": short,
                "lat": float(i["lat"]),
                "lon": float(i["lon"]),
            })
        _cset(key, results)
        return jsonify(results)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route("/api/shelters")
def shelters_endpoint():
    try:
        south = float(request.args["south"])
        west = float(request.args["west"])
        north = float(request.args["north"])
        east = float(request.args["east"])
    except (KeyError, ValueError):
        return jsonify({"error": "חסרים פרמטרים של תיחום"}), 400

    if (north - south) > 0.5 or (east - west) > 0.5:
        return jsonify({"error": "האזור גדול מדי"}), 400

    # Build a synthetic single-segment "route" from the bbox diagonal
    fake_routes = [{"geometry": {"coordinates": [
        [west, south], [east, north]
    ]}}]
    return jsonify(_fetch_shelters_along(fake_routes))


@app.route("/api/route", methods=["POST"])
def route_endpoint():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "חסר גוף JSON"}), 400

    try:
        s_lat = float(data["start"]["lat"])
        s_lon = float(data["start"]["lon"])
        e_lat = float(data["end"]["lat"])
        e_lon = float(data["end"]["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "נקודות לא תקינות"}), 400

    mode = data.get("mode", "fastest")
    # Safe radius sent directly from frontend (metres)
    safe_radius = max(100, min(1000, int(data.get("safe_radius", 350))))

    # ---- Get route alternatives ----
    routes_raw, err = _get_routes(s_lon, s_lat, e_lon, e_lat)
    if err:
        return jsonify({"error": err}), 502
    if not routes_raw:
        return jsonify({"error": "לא נמצא מסלול"}), 404

    # Fetch shelters by sampling along route geometries (fast)
    shelters = _fetch_shelters_along(routes_raw)

    processed = []
    for rt in routes_raw:
        coords = rt["geometry"]["coordinates"]
        safety = _score_route(coords, shelters, safe_radius)
        processed.append({
            "geometry": rt["geometry"],
            "distance": rt["distance"],
            "duration": rt["duration"],
            "safety": safety,
        })

    # Identify fastest (min duration) and safest (max safety score)
    fastest_idx = min(range(len(processed)), key=lambda i: processed[i]["duration"])
    safest_idx = max(range(len(processed)), key=lambda i: processed[i]["safety"]["score"])

    fastest_dur = processed[fastest_idx]["duration"]
    fastest_score = processed[fastest_idx]["safety"]["score"]

    # Filter: safe route must not exceed 10 min more than fastest
    if processed[safest_idx]["duration"] > fastest_dur + MAX_DETOUR_SECONDS:
        safest_idx = fastest_idx

    # Cost/benefit filter: extra time must be justified by safety gain
    # If eg 3 min extra only buys 0.5% more safety, not worth it
    if safest_idx != fastest_idx:
        extra_sec = processed[safest_idx]["duration"] - fastest_dur
        score_gain = processed[safest_idx]["safety"]["score"] - fastest_score
        # Require at least 1 point of safety per 30 seconds of detour
        if score_gain <= 0 or (extra_sec / score_gain) > 30:
            safest_idx = fastest_idx

    # ---- Try a waypoint detour if safe == fast ----
    if safest_idx == fastest_idx and shelters:
        detour = _try_safe_detour(
            s_lon, s_lat, e_lon, e_lat,
            processed[fastest_idx], shelters, safe_radius, fastest_dur,
        )
        if detour:
            # Apply same cost/benefit check to detour
            det_extra = detour["duration"] - fastest_dur
            det_gain = detour["safety"]["score"] - fastest_score
            if det_gain > 0 and (det_extra / det_gain) <= 30:
                processed.append(detour)
                safest_idx = len(processed) - 1

    fastest_route = processed[fastest_idx]
    fastest_route["label"] = "fastest"
    safest_route = processed[safest_idx]
    safest_route["label"] = "safest"

    result = {
        "fastest": fastest_route,
        "safest": safest_route,
        "same_route": fastest_idx == safest_idx,
        "shelters": shelters,
        "safe_radius": safe_radius,
    }

    # Include one alternative if there's a route that's neither fastest nor safest
    alt_indices = [i for i in range(len(processed))
                   if i != fastest_idx and i != safest_idx]
    if alt_indices:
        alt_rt = processed[alt_indices[0]]
        alt_rt["label"] = "alternative"
        result["alternative"] = alt_rt

    return jsonify(result)


# ---------------------------------------------------------------------------
# Routing helper – OSRM
# ---------------------------------------------------------------------------
def _get_routes(s_lon, s_lat, e_lon, e_lat, waypoints=None):
    """Return (routes_raw_list, error_string|None).

    Each route dict has {geometry: {type, coordinates}, distance, duration}.
    *waypoints* is an optional list of [lon, lat] intermediate points.
    """
    return _routes_osrm(s_lon, s_lat, e_lon, e_lat, waypoints)


def _routes_osrm(s_lon, s_lat, e_lon, e_lat, waypoints=None):
    coords_str = f"{s_lon},{s_lat}"
    if waypoints:
        for wp in waypoints:
            coords_str += f";{wp[0]},{wp[1]}"
    coords_str += f";{e_lon},{e_lat}"

    osrm_url = (
        f"{OSRM_URL}/route/v1/driving/{coords_str}"
        f"?alternatives={'true' if not waypoints else 'false'}"
        f"&overview=full&geometries=geojson&steps=false"
    )
    try:
        r = requests.get(osrm_url,
                         headers={"User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        osrm = r.json()
    except Exception as exc:
        return None, f"שגיאה בחישוב מסלול: {exc}"

    if osrm.get("code") != "Ok" or not osrm.get("routes"):
        return None, "לא נמצא מסלול"

    return osrm["routes"], None


def _try_safe_detour(s_lon, s_lat, e_lon, e_lat,
                     fastest_proc, shelters, safe_radius, fastest_dur):
    """Try to find a safer route by detouring through a shelter-dense area.

    Returns a processed route dict or None.
    """
    coords = fastest_proc["geometry"]["coordinates"]
    if len(coords) < 4:
        return None

    # Find the point on the route with the worst shelter coverage
    worst_pt = None
    worst_dist = 0
    for pt in _sample(coords, interval=2000):
        d = _nearest(pt[0], pt[1], shelters)
        if d > worst_dist:
            worst_dist = d
            worst_pt = pt

    if not worst_pt or worst_dist <= safe_radius * 1.5:
        return None  # route is already well-covered

    # Find the closest shelter to the worst point as a waypoint
    best_s = min(shelters,
                 key=lambda s: haversine(worst_pt[0], worst_pt[1],
                                         s["lon"], s["lat"]))
    waypoint = [best_s["lon"], best_s["lat"]]

    detour_routes, err = _get_routes(s_lon, s_lat, e_lon, e_lat,
                                     waypoints=[waypoint])
    if err or not detour_routes:
        return None

    rt = detour_routes[0]
    if rt["duration"] > fastest_dur + MAX_DETOUR_SECONDS:
        return None  # detour too long

    safety = _score_route(rt["geometry"]["coordinates"], shelters, safe_radius)
    if safety["score"] <= fastest_proc["safety"]["score"]:
        return None  # not actually safer

    return {
        "geometry": rt["geometry"],
        "distance": rt["distance"],
        "duration": rt["duration"],
        "safety": safety,
    }


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
