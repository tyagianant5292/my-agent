"""Postgres (Neon) persistence. Agar DATABASE_URL set nahi hai to in-memory
fallback chalega (local dev ke liye). User+assistant text messages store hote hain."""
from __future__ import annotations

import os

DATABASE_URL = os.getenv("DATABASE_URL")

# Fallback jab DB na ho: conversation_id -> list[{"role","content"}]
_memory: dict[str, list[dict]] = {}


def enabled() -> bool:
    return bool(DATABASE_URL)


def init_db() -> None:
    if not DATABASE_URL:
        return
    import psycopg

    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id              SERIAL PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                created_at      TIMESTAMPTZ DEFAULT now()
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conv ON messages (conversation_id, id)"
        )


def load_messages(conversation_id: str) -> list[dict]:
    if not DATABASE_URL:
        return list(_memory.get(conversation_id, []))
    import psycopg

    with psycopg.connect(DATABASE_URL) as conn:
        cur = conn.execute(
            "SELECT role, content FROM messages WHERE conversation_id = %s ORDER BY id",
            (conversation_id,),
        )
        return [{"role": role, "content": content} for role, content in cur.fetchall()]


def save_message(conversation_id: str, role: str, content: str) -> None:
    if not DATABASE_URL:
        _memory.setdefault(conversation_id, []).append({"role": role, "content": content})
        return
    import psycopg

    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES (%s, %s, %s)",
            (conversation_id, role, content),
        )
