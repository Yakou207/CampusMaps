"""Admin panel pages (blueprint mounted at /monitor).

Roles: "super" can do everything; "editor" can review comments and suggestions and edit stalls,
but cannot take stalls off the map, delete ratings, lift bans, manage accounts or read the audit log.
"""
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Blueprint, abort, flash, g, redirect, render_template, request, session, url_for

from places import CATEGORIES, CATEGORY_IDS

from . import queries as q

bp = Blueprint("admin", __name__, template_folder="templates", static_folder="static", static_url_path="/static")

USERNAME_RE = re.compile(r"^[a-z0-9._-]{3,32}$")
PASSWORD_MIN = 10
# area covered by static/map/campus.svg (see tools/build_map.py)
MAP_BOUNDS = {"south": 22.3485, "north": 22.3715, "west": 113.5040, "east": 113.5215}
OPEN_ENDPOINTS = {"admin.login", "admin.static"}


# ---------- session, login and CSRF ----------

def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


@bp.before_request
def guard():
    g.admin = None
    username = session.get("admin")
    if username:
        account = q.get_admin(username)
        # the session is tied to the password: changing it signs out every other session
        if account and account["active"] and session.get("pw") == account["password_hash"][-16:]:
            g.admin = account
        else:
            session.clear()
    if request.method == "POST":
        sent = request.form.get("csrf", "")
        if not session.get("csrf") or not hmac.compare_digest(sent, session["csrf"]):
            abort(400, "表单已过期，请刷新页面后重试 · The form expired; refresh and try again.")
    if request.endpoint in OPEN_ENDPOINTS:
        return None
    if not g.admin:
        return redirect(url_for("admin.login", next=request.path if request.method == "GET" else None))
    if g.admin["must_change_password"] and request.endpoint not in ("admin.password", "admin.logout"):
        flash("请先设置你自己的新密码 · Please set your own password first.", "info")
        return redirect(url_for("admin.password"))
    return None


@bp.after_request
def no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    return resp


def super_only(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.admin["role"] != "super":
            abort(403)
        return view(*args, **kwargs)
    return wrapped


@bp.app_template_filter("local_time")
def local_time(value):
    """ISO UTC timestamp (or unix seconds) -> Beijing time, minutes precision."""
    if not value:
        return "—"
    if isinstance(value, (int, float)):
        dt = datetime.fromtimestamp(value, timezone.utc)
    else:
        dt = datetime.fromisoformat(value)
    return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")


@bp.context_processor
def inject():
    extra = {"csrf_token": csrf_token, "categories": CATEGORIES, "me": g.get("admin")}
    if g.get("admin"):
        o = q.overview()
        extra["nav_counts"] = {"comments": o["pending_comments"], "suggestions": o["open_suggestions"]}
    return extra


def back_to(default_endpoint, **kwargs):
    target = request.form.get("next", "")
    if target.startswith("/monitor"):
        return redirect(target)
    return redirect(url_for(default_endpoint, **kwargs))


def clean(value, max_len):
    text = "".join(ch for ch in str(value or "") if ch >= " ").strip()
    return text[:max_len]


@bp.route("/login", methods=["GET", "POST"])
def login():
    if g.admin:
        return redirect(url_for("admin.dashboard"))
    if request.method == "POST":
        username = clean(request.form.get("username"), 32).lower()
        account, error = q.check_login(username, request.form.get("password", ""))
        if account:
            session.clear()
            session.permanent = True
            session.update(admin=username, pw=account["password_hash"][-16:], csrf=secrets.token_urlsafe(32))
            q.audit(username, "login")
            nxt = request.form.get("next", "")
            return redirect(nxt if nxt.startswith("/monitor") and not nxt.startswith("/monitor/login")
                            else url_for("admin.dashboard"))
        flash(error, "error")
    return render_template("admin/login.html", next=request.values.get("next", ""))


@bp.post("/logout")
def logout():
    q.audit(g.admin["username"], "logout")
    session.clear()
    return redirect(url_for("admin.login"))


@bp.route("/password", methods=["GET", "POST"])
def password():
    if request.method == "POST":
        current, new, again = (request.form.get(k, "") for k in ("current", "new", "again"))
        account, _ = q.check_login(g.admin["username"], current)
        if not account:
            flash("当前密码不对 · Current password is wrong.", "error")
        elif len(new) < PASSWORD_MIN:
            flash(f"新密码至少 {PASSWORD_MIN} 位 · Use at least {PASSWORD_MIN} characters.", "error")
        elif new != again:
            flash("两次输入的新密码不一致 · The new passwords don't match.", "error")
        elif new == current:
            flash("新密码不能和旧密码相同 · Choose a different password.", "error")
        else:
            q.set_password(g.admin["username"], new)
            fresh = q.get_admin(g.admin["username"])
            session["pw"] = fresh["password_hash"][-16:]
            q.audit(g.admin["username"], "password.changed")
            flash("密码已更新 · Password updated.", "ok")
            return redirect(url_for("admin.dashboard"))
    return render_template("admin/password.html")


# ---------- overview ----------

@bp.get("/")
def dashboard():
    return render_template("admin/dashboard.html", o=q.overview(),
                           recent=q.audit_entries(10) if g.admin["role"] == "super" else [])


# ---------- comments ----------

@bp.get("/comments")
def comments():
    status = request.args.get("status", "pending")
    if status not in ("pending", "approved", "rejected"):
        status = "pending"
    query = clean(request.args.get("q"), 40)
    return render_template("admin/comments.html", items=q.comments(status, query), status=status, query=query)


@bp.post("/comments/<int:rating_id>/<action>")
def comment_action(rating_id, action):
    rating = q.get_rating(rating_id) or abort(404)
    me = g.admin["username"]
    if action in ("approve", "reject"):
        status = "approved" if action == "approve" else "rejected"
        q.review_comment(rating_id, status, me)
        q.audit(me, f"comment.{action}", rating["stall_id"], rating["comment"])
        flash("已通过 · Approved." if action == "approve" else "已拒绝，评论不会公开 · Rejected; it stays hidden.", "ok")
    elif action == "delete":
        if g.admin["role"] != "super":
            abort(403)
        q.delete_rating(rating_id)
        q.audit(me, "rating.delete", rating["stall_id"], f'{rating["stars"]}★ {rating["comment"]}')
        flash("整条评分已删除 · Rating deleted.", "ok")
    else:
        abort(404)
    return back_to("admin.comments")


# ---------- suggestions ----------

@bp.get("/suggestions")
def suggestions():
    status = request.args.get("status", "open")
    if status not in ("open", "done", "rejected"):
        status = "open"
    return render_template("admin/suggestions.html", items=q.suggestions(status), status=status)


@bp.get("/suggestions/<int:suggestion_id>")
def suggestion(suggestion_id):
    item = q.get_suggestion(suggestion_id) or abort(404)
    related = q.all_stalls(item["stall_name"]) if item["stall_name"] else []
    if item["canteen_id"]:
        related += [s for s in q.all_stalls() if s["canteen_id"] == item["canteen_id"] and s not in related]
    return render_template("admin/suggestion.html", item=item, related=related[:40])


@bp.post("/suggestions/<int:suggestion_id>/<action>")
def suggestion_action(suggestion_id, action):
    item = q.get_suggestion(suggestion_id) or abort(404)
    if action not in ("done", "reject", "reopen"):
        abort(404)
    status = {"done": "done", "reject": "rejected", "reopen": "open"}[action]
    note = clean(request.form.get("note"), 200)
    q.close_suggestion(suggestion_id, status, g.admin["username"], note)
    q.audit(g.admin["username"], f"suggestion.{action}", f"#{suggestion_id}", note or item["message"][:80])
    flash({"done": "已标记为已处理 · Marked as handled.", "reject": "已拒绝 · Rejected.",
           "reopen": "已重新打开 · Reopened."}[action], "ok")
    return redirect(url_for("admin.suggestions"))


# ---------- stalls ----------

@bp.get("/stalls")
def stalls():
    query = clean(request.args.get("q"), 40)
    return render_template("admin/stalls.html", items=q.all_stalls(query), query=query)


def read_stall_form(form, existing=None):
    """Validate the stall form. Returns (values, errors)."""
    errors = {}
    v = {
        "name_zh": clean(form.get("name_zh"), 40),
        "name_en": clean(form.get("name_en"), 60),
        "category": form.get("category", "other"),
        "price": clean(form.get("price"), 30),
        "hours": clean(form.get("hours"), 40),
        "desc_zh": clean(form.get("desc_zh"), 200),
        "desc_en": clean(form.get("desc_en"), 300),
        "pick": 1 if form.get("pick") else 0,
        "canteen_id": form.get("canteen_id") or None,
    }
    if not v["name_zh"]:
        errors["name_zh"] = "请填写中文名 · Chinese name is required."
    if v["category"] not in CATEGORY_IDS:
        errors["category"] = "请选择类别 · Choose a category."
    canteen = q.get_canteen(v["canteen_id"]) if v["canteen_id"] else None
    if v["canteen_id"] and not canteen:
        errors["canteen_id"] = "找不到这个食堂 · Unknown canteen."
    try:
        lat, lon = float(form.get("lat", "")), float(form.get("lon", ""))
        inside = MAP_BOUNDS["south"] <= lat <= MAP_BOUNDS["north"] and MAP_BOUNDS["west"] <= lon <= MAP_BOUNDS["east"]
    except ValueError:
        lat = lon = None
        inside = False
    moved_into_canteen = canteen and (existing is None or existing["canteen_id"] != v["canteen_id"])
    if moved_into_canteen or (canteen and not inside):
        lat, lon = canteen["lat"], canteen["lon"]   # stalls inside a canteen sit at the canteen's marker
    elif not canteen and not inside:
        errors["location"] = "独立门店请在地图上点出位置 · Click the map to place a standalone shop."
    v["lat"], v["lon"] = lat, lon
    return v, errors


def stall_page(stall, values, errors, suggestion=None):
    return render_template("admin/stall_form.html", stall=stall, v=values, errors=errors,
                           canteens=q.all_canteens(), suggestion=suggestion, bounds=MAP_BOUNDS)


@bp.route("/stalls/new", methods=["GET", "POST"])
def stall_new():
    suggestion = q.get_suggestion(request.values.get("suggestion", type=int) or 0)
    if request.method == "POST":
        values, errors = read_stall_form(request.form)
        if not errors:
            stall_id = q.save_stall(values)
            q.audit(g.admin["username"], "stall.create", stall_id, values["name_zh"])
            if suggestion and request.form.get("close_suggestion"):
                q.close_suggestion(suggestion["id"], "done", g.admin["username"], f"created {stall_id}")
                q.audit(g.admin["username"], "suggestion.done", f"#{suggestion['id']}", f"created {stall_id}")
            flash(f"已上线：{values['name_zh']}（{stall_id}）· Published.", "ok")
            return redirect(url_for("admin.stalls", q=stall_id))
        return stall_page(None, values, errors, suggestion)
    values = {"name_zh": "", "name_en": "", "category": "other", "price": "", "hours": "", "desc_zh": "",
              "desc_en": "", "pick": 0, "canteen_id": None, "lat": "", "lon": ""}
    if suggestion:
        values.update(name_zh=suggestion["stall_name"], canteen_id=suggestion["canteen_id"])
    return stall_page(None, values, {}, suggestion)


@bp.route("/stalls/<stall_id>", methods=["GET", "POST"])
def stall_edit(stall_id):
    stall = q.get_stall(stall_id) or abort(404)
    suggestion = q.get_suggestion(request.values.get("suggestion", type=int) or 0)
    if request.method == "POST":
        values, errors = read_stall_form(request.form, existing=stall)
        if not errors:
            q.save_stall(values, stall_id)
            changed = [f for f in q.STALL_EDIT_FIELDS if str(stall[f]) != str(values[f])]
            q.audit(g.admin["username"], "stall.edit", stall_id, ", ".join(changed) or "no changes")
            if suggestion and request.form.get("close_suggestion"):
                q.close_suggestion(suggestion["id"], "done", g.admin["username"], f"edited {stall_id}")
                q.audit(g.admin["username"], "suggestion.done", f"#{suggestion['id']}", f"edited {stall_id}")
            flash(f"已保存：{values['name_zh']} · Saved.", "ok")
            return redirect(url_for("admin.stalls", q=stall_id))
        return stall_page(stall, values, errors, suggestion)
    return stall_page(stall, dict(stall), {}, suggestion)


@bp.post("/stalls/<stall_id>/<action>")
@super_only
def stall_visibility(stall_id, action):
    stall = q.get_stall(stall_id) or abort(404)
    if action not in ("hide", "show"):
        abort(404)
    q.set_stall_active(stall_id, action == "show")
    q.audit(g.admin["username"], f"stall.{action}", stall_id, stall["name_zh"])
    flash(f"已{'下架' if action == 'hide' else '恢复'}：{stall['name_zh']}", "ok")
    return back_to("admin.stalls")


# ---------- bans (super) ----------

@bp.get("/bans")
@super_only
def bans():
    return render_template("admin/bans.html", items=q.active_bans())


@bp.post("/bans/unban")
@super_only
def unban():
    client_id = clean(request.form.get("client_id"), 64)
    q.unban(client_id)
    q.audit(g.admin["username"], "ban.lift", client_id)
    flash("已解封 · Unblocked.", "ok")
    return redirect(url_for("admin.bans"))


# ---------- accounts (super) ----------

@bp.route("/accounts", methods=["GET", "POST"])
@super_only
def accounts():
    if request.method == "POST":
        username = clean(request.form.get("username"), 32).lower()
        role = request.form.get("role", "editor")
        temp = request.form.get("password", "")
        if not USERNAME_RE.match(username):
            flash("用户名：3–32 位小写字母、数字或 . _ - · Username: 3–32 lowercase letters, digits, . _ -", "error")
        elif role not in ("editor", "super"):
            flash("请选择权限 · Choose a role.", "error")
        elif len(temp) < PASSWORD_MIN:
            flash(f"初始密码至少 {PASSWORD_MIN} 位 · Initial password needs {PASSWORD_MIN}+ characters.", "error")
        elif q.get_admin(username):
            flash("这个用户名已存在 · That username exists.", "error")
        else:
            q.create_admin(username, temp, role, must_change=True)
            q.audit(g.admin["username"], "account.create", username, role)
            flash(f"已创建 {username}，对方首次登录时需要改密码 · Created; they must change the password on first login.", "ok")
            return redirect(url_for("admin.accounts"))
    return render_template("admin/accounts.html", items=q.list_admins())


@bp.post("/accounts/<username>/<action>")
@super_only
def account_action(username, action):
    account = q.get_admin(username) or abort(404)
    me = g.admin["username"]
    if username == me and action == "disable":
        flash("不能停用自己的账号 · You can't disable your own account.", "error")
    elif action in ("disable", "enable"):
        q.set_admin_active(username, action == "enable")
        q.audit(me, f"account.{action}", username)
        flash(f"已{'停用' if action == 'disable' else '启用'} {username}", "ok")
    elif action == "reset":
        temp = request.form.get("password", "")
        if len(temp) < PASSWORD_MIN:
            flash(f"临时密码至少 {PASSWORD_MIN} 位 · Temporary password needs {PASSWORD_MIN}+ characters.", "error")
        else:
            q.set_password(username, temp, must_change=True)
            q.audit(me, "account.reset_password", username)
            flash(f"已重置 {username} 的密码，对方登录后需要改密码", "ok")
    else:
        abort(404)
    return redirect(url_for("admin.accounts"))


# ---------- audit log (super) ----------

@bp.get("/audit")
@super_only
def audit():
    return render_template("admin/audit.html", items=q.audit_entries())
