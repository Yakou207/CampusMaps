-- Ratings and suggestions are the only things the website writes.
-- Canteen and stall details live in data/*.csv so the team can edit them without SQL.

CREATE TABLE IF NOT EXISTS ratings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    stall_id    TEXT    NOT NULL,
    client_id   TEXT    NOT NULL,              -- random id kept in the visitor's browser
    stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment     TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
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
