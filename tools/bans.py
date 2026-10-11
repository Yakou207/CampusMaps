"""List or lift browser-id bans created by the write rate limiter (see limit_writes in app.py).

Run on the server, from the project folder:
    .venv/bin/python tools/bans.py                  # active bans and the busiest browser ids of the last 10 min
    .venv/bin/python tools/bans.py unban <browser id>
"""
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "instance" / "campusmaps.db"


def main():
    db = sqlite3.connect(DB)
    now = time.time()
    if len(sys.argv) == 3 and sys.argv[1] == "unban":
        cid = sys.argv[2]
        n = db.execute("DELETE FROM client_bans WHERE client_id = ?", (cid,)).rowcount
        db.execute("DELETE FROM write_attempts WHERE client_id = ?", (cid,))  # fresh start, or it is blocked again at once
        db.commit()
        print(f"unbanned {cid}" if n else f"{cid} was not banned")
        return
    bans = db.execute("SELECT client_id, until, reason, created_at FROM client_bans WHERE until > ? ORDER BY until DESC",
                      (now,)).fetchall()
    print(f"Active bans: {len(bans)}")
    for cid, until, reason, created in bans:
        print(f"  {cid:<40} until {datetime.fromtimestamp(until):%Y-%m-%d %H:%M}  ({reason}; since {created})")
    busy = db.execute("SELECT client_id, COUNT(*) AS n FROM write_attempts WHERE at >= ? GROUP BY client_id "
                      "ORDER BY n DESC LIMIT 10", (now - 600,)).fetchall()
    print("Writes per browser id, last 10 min:")
    for cid, n in busy:
        print(f"  {cid:<40} {n}")


if __name__ == "__main__":
    main()
