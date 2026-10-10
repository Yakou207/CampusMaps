"""BNBU Campus Food Map — Flask app: serves the pages and a small JSON API.

Run locally:   flask --app app run --debug     (then open http://127.0.0.1:5000)
"""
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request

import database as db
from places import CATEGORIES, load_places

BASE = Path(__file__).resolve().parent
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9-]{16,64}$")
COMMENT_MAX = 200
SUGGESTION_KINDS = {"new_stall", "correction", "other"}
SUGGESTIONS_PER_HOUR = 5

app = Flask(__name__, instance_relative_config=True)
app.config.from_mapping(DATABASE=str(Path(app.instance_path) / "campusmaps.db"))
app.json.ensure_ascii = False  # send Chinese as-is instead of \u escapes
CANTEENS, STALLS = load_places(BASE / "data")
db.init_db(app.config["DATABASE"])
app.teardown_appcontext(db.close_db)


def client_id():
    """The visitor's anonymous id (sent by static/js/api.js), or None if missing/malformed."""
    cid = request.headers.get("X-Client-Id", "")
    return cid if CLIENT_ID_RE.match(cid) else None


def bad_request(errors, status=400):
    return jsonify({"ok": False, "errors": errors}), status


def clean_text(value, max_len):
    """Trim, drop control characters (keeping newlines) and report whether it was too long."""
    text = "".join(ch for ch in str(value or "") if ch == "\n" or ch >= " ").strip()
    return text, len(text) > max_len


# ---------- pages ----------

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/about")
def about():
    canteens = sorted(CANTEENS.values(), key=lambda c: (c["area"], c["id"]))
    return render_template("about.html", canteens=canteens, canteen_count=len(CANTEENS), stall_count=len(STALLS))


# ---------- API ----------

@app.get("/api/places")
def api_places():
    totals = db.rating_totals()
    stalls = []
    canteen_totals = {cid: [0, 0] for cid in CANTEENS}
    for s in STALLS.values():
        total, n = totals.get(s["id"], (0, 0))
        stalls.append({**s, "avg": round(total / n, 2) if n else None, "count": n})
        if s["canteen_id"]:
            canteen_totals[s["canteen_id"]][0] += total
            canteen_totals[s["canteen_id"]][1] += n
    canteens = []
    for c in CANTEENS.values():
        total, n = canteen_totals[c["id"]]
        # canteen score = mean of every rating given to its stalls
        canteens.append({**c, "avg": round(total / n, 2) if n else None, "count": n})
    return jsonify({"categories": CATEGORIES, "canteens": canteens, "stalls": stalls})


@app.get("/api/stalls/<stall_id>/ratings")
def api_stall_ratings(stall_id):
    if stall_id not in STALLS:
        abort(404)
    cid = client_id()
    return jsonify({
        "stall_id": stall_id,
        "summary": db.stall_summary(stall_id),
        "ratings": db.stall_ratings(stall_id, cid),
        "mine": db.own_rating(stall_id, cid),
    })


@app.post("/api/ratings")
def api_save_rating():
    data = request.get_json(silent=True) or {}
    cid = client_id()
    errors = {}
    if not cid:
        errors["client"] = "无法识别你的浏览器，请刷新页面后重试 · We couldn't identify your browser. Refresh and try again."
    stall_id = data.get("stall_id")
    if stall_id not in STALLS:
        errors["stall_id"] = "找不到这个摊位 · That stall doesn't exist."
    stars = data.get("stars")
    if not isinstance(stars, int) or isinstance(stars, bool) or not 1 <= stars <= 5:
        errors["stars"] = "请选择 1–5 颗星 · Pick 1 to 5 stars."
    comment, too_long = clean_text(data.get("comment"), COMMENT_MAX)
    if too_long:
        errors["comment"] = f"评论最多 {COMMENT_MAX} 字 · Keep comments under {COMMENT_MAX} characters."
    if errors:
        return bad_request(errors)
    created = db.save_rating(stall_id, cid, stars, comment)
    return jsonify({"ok": True, "created": created, "summary": db.stall_summary(stall_id),
                    "mine": db.own_rating(stall_id, cid)}), 201 if created else 200


@app.post("/api/suggestions")
def api_save_suggestion():
    data = request.get_json(silent=True) or {}
    cid = client_id()
    errors = {}
    if not cid:
        errors["client"] = "无法识别你的浏览器，请刷新页面后重试 · We couldn't identify your browser. Refresh and try again."
    kind = data.get("kind")
    if kind not in SUGGESTION_KINDS:
        errors["kind"] = "请选择反馈类型 · Choose what you're telling us about."
    canteen_id = data.get("canteen_id") or None
    if canteen_id and canteen_id not in CANTEENS:
        errors["canteen_id"] = "请从列表里选择地点 · Pick a place from the list."
    stall_name, too_long = clean_text(data.get("stall_name"), 40)
    if too_long:
        errors["stall_name"] = "摊位名最多 40 字 · Keep the stall name under 40 characters."
    elif kind == "new_stall" and not stall_name:
        errors["stall_name"] = "请填写摊位名称 · Tell us the stall's name."
    message, too_long = clean_text(data.get("message"), 500)
    if too_long:
        errors["message"] = "内容最多 500 字 · Keep it under 500 characters."
    elif len(message) < 5:
        errors["message"] = "请多写几个字（至少 5 个字）· Add a little more detail (5+ characters)."
    contact, too_long = clean_text(data.get("contact"), 100)
    if too_long:
        errors["contact"] = "联系方式最多 100 字 · Keep contact details under 100 characters."
    if errors:
        return bad_request(errors)
    hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
    if db.recent_suggestion_count(cid, hour_ago) >= SUGGESTIONS_PER_HOUR:
        return bad_request({"form": "提交太频繁了，请一小时后再试 · Too many submissions — try again in an hour."}, 429)
    db.save_suggestion(kind, canteen_id, stall_name, message, contact, cid)
    return jsonify({"ok": True}), 201


@app.errorhandler(404)
def not_found(_e):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "errors": {"form": "Not found"}}), 404
    return render_template("404.html"), 404
