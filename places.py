"""Canteen and stall data, read from data/canteens.csv and data/stalls.csv.

The CSV files are edited by the team (Excel or any text editor, UTF-8). They are loaded
once when the app starts; restart the app after editing them.
"""
import csv
from pathlib import Path

CATEGORIES = [
    {"id": "noodles", "zh": "粉面", "en": "Noodles"},
    {"id": "rice", "zh": "饭类", "en": "Rice"},
    {"id": "dumplings", "zh": "饺子包点", "en": "Dumplings"},
    {"id": "spicy", "zh": "麻辣烫", "en": "Mala & hot pot"},
    {"id": "meals", "zh": "正餐自选", "en": "Meals"},
    {"id": "snacks", "zh": "小吃甜品", "en": "Snacks"},
    {"id": "fastfood", "zh": "快餐", "en": "Fast food"},
    {"id": "drinks", "zh": "咖啡茶饮", "en": "Coffee & tea"},
    {"id": "other", "zh": "其他", "en": "Other"},
]
CATEGORY_IDS = {c["id"] for c in CATEGORIES}


def _read(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [{k: (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)]


def load_places(data_dir):
    """Return (canteens, stalls) as dicts keyed by id. Raises ValueError on bad rows."""
    data_dir = Path(data_dir)
    canteens, stalls = {}, {}

    for row in _read(data_dir / "canteens.csv"):
        if not row["id"] or not row["name_zh"]:
            raise ValueError(f"canteens.csv: every row needs id and name_zh ({row})")
        canteens[row["id"]] = {
            "id": row["id"],
            "name_zh": row["name_zh"],
            "name_en": row["name_en"],
            "area": row["area"],
            "lat": float(row["lat"]),
            "lon": float(row["lon"]),
            "building_id": row["building_id"],
            "hours": row["hours"],
            "note_zh": row["note_zh"],
            "note_en": row["note_en"],
        }

    for row in _read(data_dir / "stalls.csv"):
        if not row["id"] or not row["name_zh"]:
            raise ValueError(f"stalls.csv: every row needs id and name_zh ({row})")
        if row["canteen_id"] and row["canteen_id"] not in canteens:
            raise ValueError(f"stalls.csv: {row['id']} points to unknown canteen {row['canteen_id']}")
        stalls[row["id"]] = {
            "id": row["id"],
            "canteen_id": row["canteen_id"] or None,
            "name_zh": row["name_zh"],
            "name_en": row["name_en"],
            "category": row["category"] if row["category"] in CATEGORY_IDS else "other",
            "price": row["price"],
            "hours": row["hours"],
            "lat": float(row["lat"]),
            "lon": float(row["lon"]),
            "photo": row["photo"],
            "pick": row["pick"] == "1",
            "desc_zh": row["desc_zh"],
            "desc_en": row["desc_en"],
        }
    return canteens, stalls
