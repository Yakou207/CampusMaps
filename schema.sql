-- All data the website reads and writes.
-- Canteens and stalls are imported from data/*.csv the first time the app starts
-- and are edited in the admin panel (/monitor) afterwards.
-- Columns added after launch are also listed in database.MIGRATIONS so older databases get them.

CREATE TABLE IF NOT EXISTS canteens (
    id          TEXT    PRIMARY KEY,
    name_zh     TEXT    NOT NULL,
    name_en     TEXT    NOT NULL DEFAULT '',
    area        TEXT    NOT NULL DEFAULT '',       -- phase1 / phase2
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    building_id TEXT    NOT NULL DEFAULT '',       -- id of the building shape in static/map/campus.svg
    hours       TEXT    NOT NULL DEFAULT '',
    note_zh     TEXT    NOT NULL DEFAULT '',
    note_en     TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stalls (
    id          TEXT    PRIMARY KEY,
    canteen_id  TEXT    REFERENCES canteens (id),  -- NULL for a standalone shop
    name_zh     TEXT    NOT NULL,
    name_en     TEXT    NOT NULL DEFAULT '',
    category    TEXT    NOT NULL DEFAULT 'other',
    price       TEXT    NOT NULL DEFAULT '',
    hours       TEXT    NOT NULL DEFAULT '',
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    photo       TEXT    NOT NULL DEFAULT '',
    pick        INTEGER NOT NULL DEFAULT 0,
    desc_zh     TEXT    NOT NULL DEFAULT '',
    desc_en     TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,        -- 0 = taken off the map by an administrator
    updated_at  TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ratings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    stall_id       TEXT    NOT NULL,
    client_id      TEXT    NOT NULL,           -- random id kept in the visitor's browser
    stars          INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment        TEXT    NOT NULL DEFAULT '',
    comment_status TEXT    NOT NULL DEFAULT 'approved'
                   CHECK (comment_status IN ('pending', 'approved', 'rejected')),
    reviewed_by    TEXT    NOT NULL DEFAULT '',
    reviewed_at    TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    UNIQUE (stall_id, client_id)               -- one rating per visitor per stall; re-rating updates it
);

CREATE INDEX IF NOT EXISTS idx_ratings_stall ON ratings (stall_id);

CREATE TABLE IF NOT EXISTS suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL CHECK (kind IN ('new_stall', 'correction', 'other')),
    canteen_id  TEXT,
    stall_name  TEXT    NOT NULL DEFAULT '',
    message     TEXT    NOT NULL,
    contact     TEXT    NOT NULL DEFAULT '',
    client_id   TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'rejected')),
    handled_by  TEXT    NOT NULL DEFAULT '',
    handled_at  TEXT    NOT NULL DEFAULT '',
    admin_note  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL
);

-- Every write attempt (rating or suggestion) per browser id, used for rate limiting.
-- Rows older than a day are deleted. No network addresses are stored.
CREATE TABLE IF NOT EXISTS write_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT    NOT NULL,
    at          REAL    NOT NULL               -- unix time in seconds
);
CREATE INDEX IF NOT EXISTS idx_write_attempts_client ON write_attempts (client_id, at);
CREATE INDEX IF NOT EXISTS idx_write_attempts_at ON write_attempts (at);

-- Browser ids blocked from writing after flooding the API.
CREATE TABLE IF NOT EXISTS client_bans (
    client_id   TEXT    PRIMARY KEY,
    until       REAL    NOT NULL,              -- unix time the ban ends
    reason      TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

-- Admin panel accounts. Passwords are stored only as salted hashes.
CREATE TABLE IF NOT EXISTS admins (
    username       TEXT    PRIMARY KEY,
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL CHECK (role IN ('super', 'editor')),
    active         INTEGER NOT NULL DEFAULT 1,
    failed_logins  INTEGER NOT NULL DEFAULT 0,
    locked_until   REAL    NOT NULL DEFAULT 0,  -- unix time; locked after repeated wrong passwords
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL,
    last_login     TEXT    NOT NULL DEFAULT ''
);

-- Who did what in the admin panel.
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT    NOT NULL,
    username    TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    target      TEXT    NOT NULL DEFAULT '',
    detail      TEXT    NOT NULL DEFAULT ''
);
