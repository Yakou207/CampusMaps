"""Database queries used only by the admin panel."""
import time

from werkzeug.security import check_password_hash, generate_password_hash

from database import get_db, now

LOCK_AFTER = 5            # wrong passwords in a row
LOCK_SECONDS = 15 * 60


# ---------- accounts ----------

def get_admin(username):
    row = get_db().execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()
    return dict(row) if row else None


def list_admins():
    return [dict(r) for r in get_db().execute("SELECT * FROM admins ORDER BY role DESC, username")]


def create_admin(username, password, role, must_change=False):
    db = get_db()
    db.execute(
        "INSERT INTO admins (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?)",
        (username, generate_password_hash(password), role, int(must_change), now()),
    )
    db.commit()


def set_password(username, password, must_change=False):
    db = get_db()
    db.execute("UPDATE admins SET password_hash = ?, must_change_password = ?, failed_logins = 0, locked_until = 0 "
               "WHERE username = ?", (generate_password_hash(password), int(must_change), username))
    db.commit()


def set_admin_active(username, active):
    db = get_db()
    db.execute("UPDATE admins SET active = ? WHERE username = ?", (int(active), username))
    db.commit()


def check_login(username, password):
    """Return (account, error). Wrong passwords count towards a temporary lock."""
    db = get_db()
    account = get_admin(username)
    if not account or not account["active"]:
        # still spend the time of a hash check, so unknown names can't be told apart by timing
        check_password_hash(generate_password_hash("x"), password)
        return None, "用户名或密码错误 · Wrong username or password."
    if account["locked_until"] > time.time():
        minutes = max(1, round((account["locked_until"] - time.time()) / 60))
        return None, f"尝试次数过多，请 {minutes} 分钟后再试 · Too many attempts. Try again in {minutes} min."
    if not check_password_hash(account["password_hash"], password):
        failed = account["failed_logins"] + 1
        locked = time.time() + LOCK_SECONDS if failed >= LOCK_AFTER else 0
        db.execute("UPDATE admins SET failed_logins = ?, locked_until = ? WHERE username = ?",
                   (0 if locked else failed, locked, username))
        db.commit()
        return None, "用户名或密码错误 · Wrong username or password."
    db.execute("UPDATE admins SET failed_logins = 0, locked_until = 0, last_login = ? WHERE username = ?",
               (now(), username))
    db.commit()
    return account, None


# ---------- audit ----------

def audit(username, action, target="", detail=""):
    db = get_db()
    db.execute("INSERT INTO audit_log (at, username, action, target, detail) VALUES (?, ?, ?, ?, ?)",
               (now(), username, action, target, detail[:500]))
    db.commit()


def audit_entries(limit=200):
    return [dict(r) for r in get_db().execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))]


# ---------- overview ----------

def overview():
    db = get_db()
    one = lambda sql, *a: db.execute(sql, a).fetchone()[0]  # noqa: E731
    week_ago = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 7 * 86400))
    return {
        "ratings": one("SELECT COUNT(*) FROM ratings"),
        "ratings_week": one("SELECT COUNT(*) FROM ratings WHERE updated_at >= ?", week_ago),
        "pending_comments": one("SELECT COUNT(*) FROM ratings WHERE comment_status = 'pending' AND comment <> ''"),
        "open_suggestions": one("SELECT COUNT(*) FROM suggestions WHERE status = 'open'"),
        "stalls": one("SELECT COUNT(*) FROM stalls WHERE active = 1"),
        "hidden_stalls": one("SELECT COUNT(*) FROM stalls WHERE active = 0"),
        "bans": one("SELECT COUNT(*) FROM client_bans WHERE until > ?", time.time()),
        "top": [dict(r) for r in db.execute(
            "SELECT s.id, s.name_zh, s.name_en, COUNT(r.id) AS n, ROUND(AVG(r.stars), 2) AS avg "
            "FROM ratings r JOIN stalls s ON s.id = r.stall_id GROUP BY s.id ORDER BY n DESC, avg DESC LIMIT 8")],
    }


# ---------- comments ----------

def comments(status, query="", limit=200):
    sql = ("SELECT r.id, r.stall_id, r.stars, r.comment, r.comment_status, r.updated_at, r.reviewed_by, r.reviewed_at, "
           "s.name_zh, s.name_en FROM ratings r LEFT JOIN stalls s ON s.id = r.stall_id "
           "WHERE r.comment <> '' AND r.comment_status = ?")
    args = [status]
    if query:
        sql += " AND (r.comment LIKE ? OR s.name_zh LIKE ? OR s.name_en LIKE ?)"
        args += [f"%{query}%"] * 3
    sql += " ORDER BY r.updated_at " + ("ASC" if status == "pending" else "DESC") + " LIMIT ?"
    args.append(limit)
    return [dict(r) for r in get_db().execute(sql, args)]


def get_rating(rating_id):
    row = get_db().execute("SELECT * FROM ratings WHERE id = ?", (rating_id,)).fetchone()
    return dict(row) if row else None


def review_comment(rating_id, status, username):
    db = get_db()
    db.execute("UPDATE ratings SET comment_status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
               (status, username, now(), rating_id))
    db.commit()


def delete_rating(rating_id):
    db = get_db()
    db.execute("DELETE FROM ratings WHERE id = ?", (rating_id,))
    db.commit()


# ---------- suggestions ----------

def suggestions(status, limit=200):
    return [dict(r) for r in get_db().execute(
        "SELECT g.*, c.name_zh AS canteen_name FROM suggestions g LEFT JOIN canteens c ON c.id = g.canteen_id "
        "WHERE g.status = ? ORDER BY g.id " + ("ASC" if status == "open" else "DESC") + " LIMIT ?", (status, limit))]


def get_suggestion(suggestion_id):
    row = get_db().execute(
        "SELECT g.*, c.name_zh AS canteen_name FROM suggestions g LEFT JOIN canteens c ON c.id = g.canteen_id "
        "WHERE g.id = ?", (suggestion_id,)).fetchone()
    return dict(row) if row else None


def close_suggestion(suggestion_id, status, username, note=""):
    db = get_db()
    db.execute("UPDATE suggestions SET status = ?, handled_by = ?, handled_at = ?, admin_note = ? WHERE id = ?",
               (status, username, now(), note, suggestion_id))
    db.commit()


# ---------- places ----------

STALL_EDIT_FIELDS = ["canteen_id", "name_zh", "name_en", "category", "price", "hours", "lat", "lon", "pick",
                     "desc_zh", "desc_en"]


def all_canteens():
    return [dict(r) for r in get_db().execute("SELECT * FROM canteens ORDER BY area, id")]


def get_canteen(canteen_id):
    row = get_db().execute("SELECT * FROM canteens WHERE id = ?", (canteen_id,)).fetchone()
    return dict(row) if row else None


def all_stalls(query=""):
    sql = ("SELECT s.*, c.name_zh AS canteen_name FROM stalls s LEFT JOIN canteens c ON c.id = s.canteen_id")
    args = []
    if query:
        sql += " WHERE s.name_zh LIKE ? OR s.name_en LIKE ? OR c.name_zh LIKE ? OR s.id = ?"
        args = [f"%{query}%"] * 3 + [query]
    sql += " ORDER BY s.active DESC, c.id, s.name_zh"
    return [dict(r) for r in get_db().execute(sql, args)]


def get_stall(stall_id):
    row = get_db().execute("SELECT * FROM stalls WHERE id = ?", (stall_id,)).fetchone()
    return dict(row) if row else None


def next_stall_id():
    ids = [r[0] for r in get_db().execute("SELECT id FROM stalls WHERE id LIKE 's%'")]
    numbers = [int(i[1:]) for i in ids if i[1:].isdigit()]
    return f"s{max(numbers, default=0) + 1:03d}"


def save_stall(values, stall_id=None):
    """Create a stall (stall_id None) or update one. Returns its id."""
    db = get_db()
    if stall_id is None:
        stall_id = next_stall_id()
        cols = ["id"] + STALL_EDIT_FIELDS + ["updated_at"]
        db.execute(f"INSERT INTO stalls ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                   [stall_id] + [values[f] for f in STALL_EDIT_FIELDS] + [now()])
    else:
        sets = ", ".join(f"{f} = ?" for f in STALL_EDIT_FIELDS)
        db.execute(f"UPDATE stalls SET {sets}, updated_at = ? WHERE id = ?",
                   [values[f] for f in STALL_EDIT_FIELDS] + [now(), stall_id])
    db.commit()
    return stall_id


def set_stall_active(stall_id, active):
    db = get_db()
    db.execute("UPDATE stalls SET active = ?, updated_at = ? WHERE id = ?", (int(active), now(), stall_id))
    db.commit()


# ---------- bans ----------

def active_bans():
    return [dict(r) for r in get_db().execute(
        "SELECT * FROM client_bans WHERE until > ? ORDER BY until DESC", (time.time(),))]


def unban(client_id):
    db = get_db()
    db.execute("DELETE FROM client_bans WHERE client_id = ?", (client_id,))
    db.execute("DELETE FROM write_attempts WHERE client_id = ?", (client_id,))
    db.commit()
