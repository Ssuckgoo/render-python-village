"""마을 저장소. DATABASE_URL(Postgres)이 있으면 사용하고, 없으면 로컬 SQLite 파일.

마을 하나 = JSON 문서 한 행. 동기 함수라 호출부에서 asyncio.to_thread로 감싼다.
"""
import json
import os
import sqlite3
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "")
USE_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
SQLITE_PATH = Path(__file__).resolve().parent.parent / "village.db"


def _pg():
    import psycopg
    return psycopg.connect(DATABASE_URL, autocommit=True)


def init():
    if USE_PG:
        with _pg() as c:
            c.execute("CREATE TABLE IF NOT EXISTS villages ("
                      "code TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ DEFAULT now())")
    else:
        with sqlite3.connect(SQLITE_PATH) as c:
            c.execute("CREATE TABLE IF NOT EXISTS villages (code TEXT PRIMARY KEY, data TEXT NOT NULL)")


def load(code):
    if USE_PG:
        with _pg() as c:
            row = c.execute("SELECT data FROM villages WHERE code = %s", (code,)).fetchone()
            return row[0] if row else None
    with sqlite3.connect(SQLITE_PATH) as c:
        row = c.execute("SELECT data FROM villages WHERE code = ?", (code,)).fetchone()
        return json.loads(row[0]) if row else None


def save(code, data):
    text = json.dumps(data, ensure_ascii=False)
    if USE_PG:
        with _pg() as c:
            c.execute("INSERT INTO villages (code, data, updated) VALUES (%s, %s::jsonb, now()) "
                      "ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated = now()",
                      (code, text))
    else:
        with sqlite3.connect(SQLITE_PATH) as c:
            c.execute("INSERT INTO villages (code, data) VALUES (?, ?) "
                      "ON CONFLICT(code) DO UPDATE SET data = excluded.data", (code, text))


def exists(code):
    return load(code) is not None


def storage_name():
    return "Postgres" if USE_PG else "SQLite (임시)"
