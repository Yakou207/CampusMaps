"""Convert the annotation tool's JSON export into the two CSV files the website reads.

Input : tools/annotations.json        (exported from tools/annotate.html)
Output: data/canteens.csv, data/stalls.csv

The CSV files are the source of truth afterwards — edit them in Excel / a text editor
(they are UTF-8 with BOM so Excel shows Chinese correctly). Re-running this script
overwrites them, so only run it again if you redo the annotation from scratch.

Run:  python3 tools/import_annotations.py
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "annotations.json"
DATA = ROOT / "data"

PHASE2_LAT = 22.357  # dormitory area (phase 2) lies north of this latitude

CANTEEN_FIELDS = ["id", "name_zh", "name_en", "area", "lat", "lon", "building_id", "hours", "note_zh", "note_en"]
STALL_FIELDS = ["id", "canteen_id", "name_zh", "name_en", "category", "price", "hours", "lat", "lon",
                "photo", "pick", "desc_zh", "desc_en", "osm_id"]


def main():
    places = [p for p in json.loads(SRC.read_text(encoding="utf-8"))["places"] if p["status"] != "removed"]
    canteens = sorted((p for p in places if p["kind"] == "canteen"), key=lambda p: (-p["lat"], p["lon"]))
    canteen_ids = {}
    canteen_rows = []
    for i, c in enumerate(canteens, 1):
        cid = f"c{i:02d}"
        canteen_ids[c["id"]] = cid
        canteen_rows.append({
            "id": cid,
            "name_zh": " ".join(c["name_zh"].split()),
            "name_en": c["name_en"].strip(),
            "area": "phase2" if c["lat"] > PHASE2_LAT else "phase1",
            "lat": c["lat"], "lon": c["lon"],
            "building_id": c.get("building_id") or "",
            "hours": "", "note_zh": c.get("note", ""), "note_en": "",
        })

    stalls = [p for p in places if p["kind"] == "stall"]
    stalls.sort(key=lambda p: (canteen_ids.get(p.get("canteen_id"), "zz"), p["name_zh"]))
    stall_rows = []
    for i, s in enumerate(stalls, 1):
        stall_rows.append({
            "id": f"s{i:03d}",
            "canteen_id": canteen_ids.get(s.get("canteen_id"), ""),
            "name_zh": " ".join(s["name_zh"].split()),
            "name_en": s["name_en"].strip(),
            "category": "", "price": "", "hours": "",
            "lat": s["lat"], "lon": s["lon"],
            "photo": "", "pick": "0", "desc_zh": s.get("note", ""), "desc_en": "",
            "osm_id": s["id"].removeprefix("osm-") if s["source"] == "osm" else "",
        })

    DATA.mkdir(exist_ok=True)
    for name, fields, rows in (("canteens.csv", CANTEEN_FIELDS, canteen_rows), ("stalls.csv", STALL_FIELDS, stall_rows)):
        with open(DATA / name, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    print(f"{len(canteen_rows)} canteens, {len(stall_rows)} stalls -> data/")


if __name__ == "__main__":
    main()
