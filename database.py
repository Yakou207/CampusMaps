"""SQLite access for the public site: places, ratings, suggestions and write limits.
(Queries used only by the admin panel live in admin/queries.py.)

Every query uses ? placeholders, so user input is never pasted into SQL text
(this is what prevents SQL injection).
"""
import fcntl
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app, g

from places import load_places

ROOT = Path(__file__).resolve().parent
SCHEMA = ROOT / "schema.sql"

# Columns added after the first release; init_db adds any that an older database lacks.
MIGRATIONS = {
    "ratings": [
        ("comment_status", "TEXT NOT NULL DEFAULT 'approved'"),   # comments written before review existed stay public
        ("reviewed_by", "TEXT NOT NULL DEFAULT ''"),
        ("reviewed_at", "TEXT NOT NULL DEFAULT ''"),
    ],
    "suggestions": [
        ("status", "TEXT NOT NULL DEFAULT 'open'"),
        ("handled_by", "TEXT NOT NULL DEFAULT ''"),
        ("handled_at", "TEXT NOT NULL DEFAULT ''"),
        ("admin_note", "TEXT NOT NULL DEFAULT ''"),
    ],
}

PLACE_FIELDS = {
    "canteens": ["id", "name_zh", "name_en", "area", "lat", "lon", "building_id", "hours", "note_zh", "note_en"],
    "stalls": ["id", "canteen_id", "name_zh", "name_en", "category", "price", "hours", "lat", "lon", "photo", "pick",
               "desc_zh", "desc_en"],
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(path):
    """Create tables, add columns missing from older databases, and import the place
    list from data/*.csv the first time (after that the admin panel edits it)."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    # gunicorn starts several workers at once; the lock makes them set up the database one at a time
    with open(Path(path).with_suffix(".lock"), "w") as lock, sqlite3.connect(path) as db:
        fcntl.flock(lock, fcntl.LOCK_EX)
        db.executescript(SCHEMA.read_text(encoding="utf-8"))
        for table, columns in MIGRATIONS.items():
            existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            for name, definition in columns:
                if name not in existing:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
        if db.execute("SELECT COUNT(*) FROM canteens").fetchone()[0] == 0:
            canteens, stalls = load_places(ROOT / "data")
            for table, rows in (("canteens", canteens.values()), ("stalls", stalls.values())):
                fields = PLACE_FIELDS[table]
                db.executemany(
                    f"INSERT INTO {table} ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                    [[int(r[f]) if f == "pick" else r[f] for f in fields] for r in rows],
                )


# ---------- places ----------

def _place(row):
    d = dict(row)
    if "pick" in d:
        d["pick"] = bool(d["pick"])
    d.pop("active", None)
    d.pop("updated_at", None)
    return d


def get_canteens():
    """Active canteens, keyed by id."""
    rows = get_db().execute("SELECT * FROM canteens WHERE active = 1 ORDER BY id")
    return {r["id"]: _place(r) for r in rows}


def get_stalls():
    """Active stalls whose canteen (if any) is active, keyed by id."""
    rows = get_db().execute(
        "SELECT s.* FROM stalls s LEFT JOIN canteens c ON c.id = s.canteen_id "
        "WHERE s.active = 1 AND (s.canteen_id IS NULL OR c.active = 1) ORDER BY s.id")
    return {r["id"]: _place(r) for r in rows}


def stall_exists(stall_id):
    return stall_id in get_stalls()


def canteen_exists(canteen_id):
    return get_db().execute("SELECT 1 FROM canteens WHERE id = ? AND active = 1", (canteen_id,)).fetchone() is not None


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
    """Recent ratings. Stars always count; a comment is shown only once approved,
    except to the visitor who wrote it (who also sees its review status)."""
    rows = get_db().execute(
        "SELECT stars, comment, comment_status, created_at, updated_at, client_id = ? AS mine FROM ratings "
        "WHERE stall_id = ? ORDER BY updated_at DESC LIMIT ?",
        (client_id or "", stall_id, limit),
    )
    out = []
    for r in rows:
        item = {"stars": r["stars"], "created_at": r["created_at"], "updated_at": r["updated_at"], "mine": bool(r["mine"])}
        if item["mine"]:
            item["comment"], item["comment_status"] = r["comment"], r["comment_status"]
        else:
            item["comment"] = r["comment"] if r["comment_status"] == "approved" else ""
        out.append(item)
    return out


def own_rating(stall_id, client_id):
    if not client_id:
        return None
    row = get_db().execute(
        "SELECT stars, comment, comment_status, updated_at FROM ratings WHERE stall_id = ? AND client_id = ?",
        (stall_id, client_id),
    ).fetchone()
    return dict(row) if row else None


def save_rating(stall_id, client_id, stars, comment):
    """Insert, or update this visitor's earlier rating. Returns True if it was new.
    A new or changed comment waits for review; an empty comment needs none."""
    db = get_db()
    earlier = own_rating(stall_id, client_id)
    if not comment:
        status = "approved"
    elif earlier and earlier["comment"] == comment:
        status = earlier["comment_status"]
    else:
        status = "pending"
    ts = now()
    db.execute(
        "INSERT INTO ratings (stall_id, client_id, stars, comment, comment_status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (stall_id, client_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment, "
        "comment_status = excluded.comment_status, updated_at = excluded.updated_at",
        (stall_id, client_id, stars, comment, status, ts, ts),
    )
    db.commit()
    return earlier is None


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


# ---------- rate limiting ----------

def record_write(client_id, at):
    """Log one write attempt and drop entries older than a day."""
    db = get_db()
    db.execute("INSERT INTO write_attempts (client_id, at) VALUES (?, ?)", (client_id, at))
    db.execute("DELETE FROM write_attempts WHERE at < ?", (at - 86400,))
    db.commit()


def writes_since(client_id, since):
    return get_db().execute(
        "SELECT COUNT(*) FROM write_attempts WHERE client_id = ? AND at >= ?", (client_id, since)).fetchone()[0]


def ban_until(client_id, at):
    """End time of an active ban on this browser id, or None."""
    row = get_db().execute("SELECT until FROM client_bans WHERE client_id = ? AND until > ?", (client_id, at)).fetchone()
    return row[0] if row else None


def ban(client_id, until, reason):
    db = get_db()
    db.execute(
        "INSERT INTO client_bans (client_id, until, reason, created_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (client_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, "
        "created_at = excluded.created_at",
        (client_id, until, reason, now()),
    )
    db.commit()
