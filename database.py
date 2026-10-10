"""SQLite access for ratings and suggestions.

Every query uses ? placeholders, so user input is never pasted into SQL text
(this is what prevents SQL injection).
"""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app, g

SCHEMA = Path(__file__).resolve().parent / "schema.sql"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA.read_text(encoding="utf-8"))


# ---------- ratings ----------

def rating_totals():
    """{stall_id: (sum_of_stars, count)} for every stall that has ratings."""
    rows = get_db().execute("SELECT stall_id, SUM(stars) AS total, COUNT(*) AS n FROM ratings GROUP BY stall_id")
    return {r["stall_id"]: (r["total"], r["n"]) for r in rows}


def stall_summary(stall_id):
    rows = get_db().execute("SELECT stars, COUNT(*) AS n FROM ratings WHERE stall_id = ? GROUP BY stars", (stall_id,))
    distribution = {str(s): 0 for s in range(1, 6)}
    for r in rows:
        distribution[str(r["stars"])] = r["n"]
    count = sum(distribution.values())
    total = sum(int(s) * n for s, n in distribution.items())
    return {"avg": round(total / count, 2) if count else None, "count": count, "distribution": distribution}


def stall_ratings(stall_id, client_id, limit=50):
    rows = get_db().execute(
        "SELECT stars, comment, created_at, updated_at, client_id = ? AS mine FROM ratings "
        "WHERE stall_id = ? ORDER BY updated_at DESC LIMIT ?",
        (client_id or "", stall_id, limit),
    )
    return [dict(r, mine=bool(r["mine"])) for r in rows]


def own_rating(stall_id, client_id):
    if not client_id:
        return None
    row = get_db().execute(
        "SELECT stars, comment, updated_at FROM ratings WHERE stall_id = ? AND client_id = ?", (stall_id, client_id)
    ).fetchone()
    return dict(row) if row else None


def save_rating(stall_id, client_id, stars, comment):
    """Insert, or update this visitor's earlier rating. Returns True if it was new."""
    db = get_db()
    existed = own_rating(stall_id, client_id) is not None
    ts = now()
    db.execute(
        "INSERT INTO ratings (stall_id, client_id, stars, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (stall_id, client_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment, "
        "updated_at = excluded.updated_at",
        (stall_id, client_id, stars, comment, ts, ts),
    )
    db.commit()
    return not existed


# ---------- suggestions ----------

def recent_suggestion_count(client_id, since_iso):
    row = get_db().execute(
        "SELECT COUNT(*) FROM suggestions WHERE client_id = ? AND created_at >= ?", (client_id, since_iso)
    ).fetchone()
    return row[0]


def save_suggestion(kind, canteen_id, stall_name, message, contact, client_id):
    db = get_db()
    db.execute(
        "INSERT INTO suggestions (kind, canteen_id, stall_name, message, contact, client_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (kind, canteen_id, stall_name, message, contact, client_id, now()),
    )
    db.commit()
