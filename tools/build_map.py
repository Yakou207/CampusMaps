"""Build the hand-drawn style SVG campus map and a food POI list from OpenStreetMap data.

Input : tools/osm_raw.json  (Overpass API response for tools/overpass_query.txt)
Output: static/map/campus.svg    layered, class-based SVG (colours come from static/css/map.css)
                                 every building is <g id="b-w123" class="building">
        static/map/osm_food.json food places already in OSM (seed data for tools/annotate.html)

The "hand-drawn" look is produced here, once, at build time:
  * outlines are resampled and nudged by small random offsets, then smoothed into curves
  * each building gets two slightly different pencil outlines, a fill that is printed a
    little off-register, and a soft offset shadow (a cheap 2.5D effect)
A fixed random seed keeps the output identical between runs.

Map data (c) OpenStreetMap contributors, ODbL.
Run:  python3 tools/build_map.py
"""
import html
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "osm_raw.json"
OUT_SVG = ROOT / "static" / "map" / "campus.svg"
OUT_FOOD = ROOT / "static" / "map" / "osm_food.json"

SOUTH, WEST, NORTH, EAST = 22.3485, 113.5040, 22.3715, 113.5215
WIDTH = 2400  # SVG units across the bounding box

rng = random.Random(20261011)


def merc_y(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


K = WIDTH / math.radians(EAST - WEST)
HEIGHT = (merc_y(NORTH) - merc_y(SOUTH)) * K


def project(lat, lon):
    """Web Mercator -> SVG units. The inverse lives in static/js/map.js and tools/annotate.js."""
    return math.radians(lon - WEST) * K, (merc_y(NORTH) - merc_y(lat)) * K


# ---------- geometry helpers ----------

def pts(geometry):
    return [(p["lat"], p["lon"]) for p in geometry if p]


def join_rings(segments):
    """Join multipolygon member ways that share end points into closed rings."""
    segs = [list(s) for s in segments if len(s) > 1]
    rings = []
    while segs:
        ring = segs.pop(0)
        joined = True
        while ring[0] != ring[-1] and joined:
            joined = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s + ring[1:]
                elif s[0] == ring[0]:
                    ring = s[::-1] + ring[1:]
                else:
                    continue
                segs.pop(i)
                joined = True
                break
        rings.append(ring)
    return rings


def rings_of(el):
    if el["type"] == "way":
        return [pts(el.get("geometry", []))]
    members = [pts(m.get("geometry", [])) for m in el.get("members", []) if m["type"] == "way"]
    return join_rings(members)


def xy_rings(rings):
    return [[project(lat, lon) for lat, lon in ring] for ring in rings if len(ring) > 1]


def num(v):
    """Shortest 1-decimal form: 0.5 -> .5, -0.5 -> -.5, 3.0 -> 3."""
    s = f"{v:.1f}".rstrip("0").rstrip(".")
    if s in ("", "-", "-0"):
        return "0"
    return s.replace("0.", ".", 1) if s.startswith(("0.", "-0.")) else s


class Pen:
    """Writes path data with relative commands, which keeps the SVG file small."""

    def __init__(self):
        self.d, self.x, self.y = [], 0.0, 0.0

    def _rel(self, x, y):
        # round to the grid we write, so rounding errors don't accumulate
        dx, dy = round(x - self.x, 1), round(y - self.y, 1)
        self.x, self.y = self.x + dx, self.y + dy
        return f"{num(dx)},{num(dy)}"

    def move(self, x, y):
        self.d.append("m" + self._rel(x, y))

    def line(self, x, y):
        self.d.append("l" + self._rel(x, y))

    def quad(self, cx, cy, x, y):
        ox, oy = self.x, self.y
        c = f"{num(round(cx - ox, 1))},{num(round(cy - oy, 1))}"
        self.d.append("q" + c + " " + self._rel(x, y))

    def close(self, x0, y0):
        self.d.append("z")
        self.x, self.y = x0, y0  # after z the current point returns to the subpath start

    def __str__(self):
        return "".join(self.d)


def plain_d(rings, closed=True, dx=0.0, dy=0.0):
    pen = Pen()
    for xy in rings:
        pen.move(xy[0][0] + dx, xy[0][1] + dy)
        start = (pen.x, pen.y)
        for x, y in xy[1:]:
            pen.line(x + dx, y + dy)
        if closed:
            pen.close(*start)
    return str(pen)


def wobble(xy, closed, amp, step):
    """Resample a polyline every `step` units and push each point sideways by up to `amp`."""
    if closed and xy[0] != xy[-1]:
        xy = xy + [xy[0]]
    out = []
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 1e-6:
            continue
        nx, ny = -(y1 - y0) / length, (x1 - x0) / length
        n = max(1, round(length / step))
        for i in range(n):
            t = i / n
            off = rng.uniform(-amp, amp)
            out.append((x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off))
    if not closed:
        out.append(xy[-1])
    return out


def sketch_d(rings, closed=True, amp=0.6, step=7.0):
    """Smooth curve through wobbled points (quadratic segments between midpoints)."""
    pen = Pen()
    for xy in rings:
        p = wobble(xy, closed, amp, step)
        if len(p) < 2:
            continue
        if closed:
            p = p + p[:2]
        mids = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(p, p[1:])]
        pen.move(*(mids[0] if closed else p[0]))
        start = (pen.x, pen.y)
        for ctrl, end in zip(p[1:], mids[1:]):
            pen.quad(*ctrl, *end)
        if closed:
            pen.close(*start)
        else:
            pen.line(*p[-1])
    return str(pen)


def centroid(xy):
    """Area-weighted centroid in SVG units (falls back to the vertex mean)."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(xy, xy[1:] + xy[:1]):
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if abs(a) < 1e-6:
        return sum(p[0] for p in xy) / len(xy), sum(p[1] for p in xy) / len(xy)
    return cx / (3 * a), cy / (3 * a)


def contains(ring, lat, lon):
    inside = False
    for (la0, lo0), (la1, lo1) in zip(ring, ring[1:] + ring[:1]):
        if (la0 > lat) != (la1 > lat) and lon < (lo1 - lo0) * (lat - la0) / (la1 - la0) + lo0:
            inside = not inside
    return inside


# ---------- classification ----------

def area_class(t):
    if t.get("amenity") == "university":
        return "campus"
    if t.get("natural") == "water":
        return "water"
    if t.get("natural") == "wood" or t.get("landuse") == "forest":
        return "wood"
    if t.get("leisure") in ("pitch", "sports_centre", "playground", "track"):
        return "pitch"
    if t.get("landuse") in ("grass", "meadow", "greenfield") or t.get("natural") in ("wetland", "grassland", "scrub") \
            or t.get("leisure") in ("park", "garden"):
        return "green"
    if t.get("landuse") in ("farmland", "farmyard"):
        return "farm"
    if t.get("landuse") == "construction":
        return "construction"
    if t.get("amenity") == "parking":
        return "parking"
    if t.get("highway") in ("pedestrian", "footway") and t.get("area") == "yes":
        return "plaza"
    if "landuse" in t:
        return "landuse"
    return None


AREA_ORDER = ["campus", "landuse", "farm", "construction", "green", "wood", "pitch", "parking", "plaza", "water"]
OUTLINED_AREAS = {"water", "pitch", "wood"}

ROAD_CLASS = {
    "primary": "major", "primary_link": "major", "trunk": "major", "secondary": "major",
    "tertiary": "minor", "unclassified": "minor", "residential": "minor", "living_street": "minor",
    "service": "service",
    "footway": "path", "path": "path", "pedestrian": "path", "cycleway": "path", "track": "path", "steps": "path",
}
CASED_ROADS = ("minor", "major")

FOOD = {"restaurant", "fast_food", "cafe", "food_court", "canteen", "bakery", "ice_cream"}

DEFS = """<defs>
<pattern id="pat-trees" width="26" height="22" patternUnits="userSpaceOnUse">
 <path class="pat-stroke" d="M4 12q3-7 6 0q-3 2-6 0M7 12v4M17 5q3-6 6 0q-3 2-6 0M20 5v4M15 19q2.5-5 5 0q-2.5 1.6-5 0"/>
</pattern>
<pattern id="pat-water" width="34" height="16" patternUnits="userSpaceOnUse">
 <path class="pat-stroke" d="M3 6q3-2.5 6 0t6 0M19 13q3-2.5 6 0t6 0"/>
</pattern>
<pattern id="pat-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
 <path class="pat-stroke" d="M0 3h6"/>
</pattern>
</defs>"""


def main():
    elements = json.loads(SRC.read_text(encoding="utf-8"))["elements"]

    areas = {k: [] for k in AREA_ORDER}
    area_lines = []
    roads = {k: [] for k in ROAD_CLASS.values()}
    waterways, buildings, labels = [], [], []
    building_rings = []  # (id, name, outer ring) for point-in-polygon
    food = []

    for el in elements:
        t = el.get("tags", {})
        if el["type"] == "node":
            if t.get("amenity") in FOOD:
                food.append({"osm_id": f"n{el['id']}", "lat": el["lat"], "lon": el["lon"], "tags": t})
            continue

        if "building" in t:
            rings = rings_of(el)
            xy = xy_rings(rings)
            if not xy:
                continue
            bid = f"b-{el['type'][0]}{el['id']}"
            name = t.get("name", "")
            attrs = f'id="{bid}" class="building"'
            if name:
                attrs += f' data-name="{html.escape(name)}"'
            if t.get("name:en"):
                attrs += f' data-name-en="{html.escape(t["name:en"])}"'
            buildings.append(
                f'<g {attrs}>'
                f'<path class="b-shadow" d="{plain_d(xy, dx=2.6, dy=2.6)}"/>'
                f'<path class="b-fill" d="{plain_d(xy, dx=0.9, dy=0.7)}"/>'
                f'<path class="b-line" d="{sketch_d(xy, amp=0.55, step=6)}"/>'
                f'<path class="b-line b-line-2" d="{sketch_d(xy, amp=0.8, step=9)}"/>'
                f'</g>')
            building_rings.append((bid, name, rings[0]))
            if name:
                x, y = centroid(xy[0])
                labels.append(f'<text class="label-building" x="{x:.1f}" y="{y:.1f}">{html.escape(name)}</text>')
            if t.get("amenity") in FOOD:
                lat = sum(p[0] for p in rings[0]) / len(rings[0])
                lon = sum(p[1] for p in rings[0]) / len(rings[0])
                food.append({"osm_id": f"{el['type'][0]}{el['id']}", "lat": lat, "lon": lon, "tags": t})
            continue

        if "waterway" in t:
            cls = "waterway river" if t["waterway"] == "river" else "waterway"
            waterways.append(f'<path class="{cls}" d="{sketch_d(xy_rings(rings_of(el)), closed=False, amp=1.2, step=14)}"/>')
            continue

        cls = area_class(t)
        if cls:
            xy = xy_rings(rings_of(el))
            if not xy:
                continue
            areas[cls].append(f'<path d="{plain_d(xy, dx=1.2, dy=1.0)}"/>')
            if cls in OUTLINED_AREAS:
                area_lines.append(f'<path class="line-{cls}" d="{sketch_d(xy, amp=1.0, step=12)}"/>')
            if cls in ("water", "green", "pitch") and t.get("name") and el["type"] == "way":
                x, y = centroid(xy[0])
                labels.append(f'<text class="label-{cls}" x="{x:.1f}" y="{y:.1f}">{html.escape(t["name"])}</text>')
            continue

        road = ROAD_CLASS.get(t.get("highway"))
        if road:
            amp, step = (0.5, 16) if road == "path" else (0.9, 20)
            roads[road].append(sketch_d(xy_rings(rings_of(el)), closed=False, amp=amp, step=step))

    # Which building is each food place inside? (groups stalls into canteens)
    for f in food:
        f["building_id"] = None
        f["building_name"] = None
        for bid, name, ring in building_rings:
            if f["osm_id"] != bid[2:] and contains(ring, f["lat"], f["lon"]):
                f["building_id"], f["building_name"] = bid, name or None
                break

    def road_group(cls, d_list, layer):
        return f'<g class="road-{cls} {layer}">' + "".join(f'<path d="{d}"/>' for d in d_list) + "</g>"

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT:.1f}" '
        f'data-west="{WEST}" data-north="{NORTH}" data-k="{K:.4f}" role="img" '
        f'aria-label="BNBU campus map">',
        DEFS,
        f'<rect class="ground" width="{WIDTH}" height="{HEIGHT:.1f}"/>',
    ]
    for cls in AREA_ORDER:
        out.append(f'<g class="area-{cls}">' + "".join(areas[cls]) + "</g>")
    # texture overlays reuse the same shapes
    out.append('<g class="tex-wood">' + "".join(areas["wood"]) + "</g>")
    out.append('<g class="tex-water">' + "".join(areas["water"]) + "</g>")
    out.append('<g class="area-lines">' + "".join(area_lines) + "</g>")
    out.append('<g class="waterways">' + "".join(waterways) + "</g>")
    out.append('<g class="roads">')
    out.append(road_group("path", roads["path"], "road-dash"))
    for cls in ("service", "minor", "major"):
        if cls in CASED_ROADS:
            out.append(road_group(cls, roads[cls], "road-casing"))
    for cls in ("service", "minor", "major"):
        out.append(road_group(cls, roads[cls], "road-fill"))
    out.append("</g>")
    out.append('<g class="buildings">' + "".join(buildings) + "</g>")
    out.append('<g class="labels">' + "".join(labels) + "</g>")
    out.append("</svg>")
    OUT_SVG.parent.mkdir(parents=True, exist_ok=True)
    OUT_SVG.write_text("\n".join(out), encoding="utf-8")

    food_out = [{
        "osm_id": f["osm_id"],
        "name_zh": f["tags"].get("name", ""),
        "name_en": f["tags"].get("name:en", ""),
        "amenity": f["tags"].get("amenity"),
        "lat": round(f["lat"], 7),
        "lon": round(f["lon"], 7),
        "building_id": f["building_id"],
        "building_name": f["building_name"],
    } for f in food]
    OUT_FOOD.write_text(json.dumps(food_out, ensure_ascii=False, indent=1), encoding="utf-8")
    size_kb = OUT_SVG.stat().st_size / 1024
    print(f"SVG {WIDTH}x{HEIGHT:.0f} ({size_kb:.0f} KB): {len(buildings)} buildings, "
          f"{sum(map(len, roads.values()))} roads, {len(food_out)} food places")


if __name__ == "__main__":
    main()
