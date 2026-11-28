from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend import config

CATEGORIES = ("decisions", "requests", "waiting_materials", "undecided")


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def get_conn() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    db_path: Path = config.DATA_DIR / "app.db"
    conn = sqlite3.connect(str(db_path), timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                client_name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                agenda TEXT NOT NULL DEFAULT '',
                duration_minutes INTEGER NOT NULL DEFAULT 60,
                status TEXT NOT NULL DEFAULT 'active',
                summary_markdown TEXT NOT NULL DEFAULT '',
                started_at TEXT NOT NULL,
                ended_at TEXT
            );

            CREATE TABLE IF NOT EXISTS utterances (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                seq_no INTEGER NOT NULL,
                speaker TEXT NOT NULL DEFAULT '参加者',
                text TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS board_items (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                is_locked INTEGER NOT NULL DEFAULT 0,
                carried_from_meeting_id TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                agent_role TEXT NOT NULL,
                model_name TEXT NOT NULL,
                latency_ms INTEGER NOT NULL,
                success INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )

        row = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()
        if row is None:
            pid = str(uuid.uuid4())
            now = _now_iso()
            conn.execute(
                "INSERT INTO projects (id, name, client_name, created_at) VALUES (?, ?, ?, ?)",
                (pid, "Webサイトリニューアル案件", "株式会社サンプル", now),
            )
            mid = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO meetings (id, project_id, title, agenda, duration_minutes, status, started_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?)
                """,
                (
                    mid,
                    pid,
                    "第1回 構成・素材スケジュール打ち合わせ",
                    "トップページ構成、写真素材の支給スケジュール、お問い合わせフォーム仕様の決定",
                    45,
                    now,
                ),
            )


def list_projects() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


def create_project(name: str, client_name: str = "") -> dict[str, Any]:
    pid = str(uuid.uuid4())
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO projects (id, name, client_name, created_at) VALUES (?, ?, ?, ?)",
            (pid, name.strip(), client_name.strip(), now),
        )
    return {"id": pid, "name": name.strip(), "client_name": client_name.strip(), "created_at": now}


def list_meetings(project_id: str | None = None) -> list[dict[str, Any]]:
    with get_conn() as conn:
        if project_id:
            rows = conn.execute(
                """
                SELECT m.*, p.name AS project_name, p.client_name
                FROM meetings m
                JOIN projects p ON p.id = m.project_id
                WHERE m.project_id = ?
                ORDER BY m.started_at DESC
                """,
                (project_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT m.*, p.name AS project_name, p.client_name
                FROM meetings m
                JOIN projects p ON p.id = m.project_id
                ORDER BY m.started_at DESC
                """
            ).fetchall()

        board_count_rows = conn.execute(
            """
            SELECT meeting_id, category, COUNT(*) AS cnt
            FROM board_items
            GROUP BY meeting_id, category
            """
        ).fetchall()
        utterance_count_rows = conn.execute(
            """
            SELECT meeting_id, COUNT(*) AS cnt
            FROM utterances
            GROUP BY meeting_id
            """
        ).fetchall()

    counts_by_meeting: dict[str, dict[str, int]] = {}
    for r in board_count_rows:
        mid = r["meeting_id"]
        cat = r["category"]
        if mid not in counts_by_meeting:
            counts_by_meeting[mid] = {c: 0 for c in CATEGORIES}
        if cat in counts_by_meeting[mid]:
            counts_by_meeting[mid][cat] = int(r["cnt"])

    utterance_counts = {r["meeting_id"]: int(r["cnt"]) for r in utterance_count_rows}

    result: list[dict[str, Any]] = []
    for r in rows:
        item = dict(r)
        mid = item["id"]
        item["board_counts"] = counts_by_meeting.get(mid, {c: 0 for c in CATEGORIES})
        item["utterance_count"] = utterance_counts.get(mid, 0)
        result.append(item)
    return result


def create_meeting(
    project_id: str,
    title: str,
    agenda: str,
    duration_minutes: int = 45,
    carry_over: bool = True,
) -> dict[str, Any]:
    mid = str(uuid.uuid4())
    now = _now_iso()
    with get_conn() as conn:
        prev = conn.execute(
            "SELECT id FROM meetings WHERE project_id = ? ORDER BY started_at DESC LIMIT 1",
            (project_id,),
        ).fetchone()

        conn.execute(
            """
            INSERT INTO meetings (id, project_id, title, agenda, duration_minutes, status, started_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?)
            """,
            (mid, project_id, title.strip(), agenda.strip(), duration_minutes, now),
        )

        # 前回会議の未解決項目（素材待ち・未決定事項）を次回へ自動引き継ぎ
        if carry_over and prev is not None:
            carry_rows = conn.execute(
                """
                SELECT category, content FROM board_items
                WHERE meeting_id = ? AND category IN ('waiting_materials', 'undecided')
                """,
                (prev["id"],),
            ).fetchall()
            for r in carry_rows:
                conn.execute(
                    """
                    INSERT INTO board_items (id, meeting_id, category, content, is_locked, carried_from_meeting_id, updated_at)
                    VALUES (?, ?, ?, ?, 0, ?, ?)
                    """,
                    (str(uuid.uuid4()), mid, r["category"], r["content"], prev["id"], now),
                )
    return get_meeting_detail(mid)


def get_meeting_detail(meeting_id: str) -> dict[str, Any]:
    with get_conn() as conn:
        m = conn.execute(
            """
            SELECT m.*, p.name AS project_name, p.client_name
            FROM meetings m
            JOIN projects p ON p.id = m.project_id
            WHERE m.id = ?
            """,
            (meeting_id,),
        ).fetchone()
        if m is None:
            raise KeyError(f"Meeting not found: {meeting_id}")

        u_rows = conn.execute(
            "SELECT * FROM utterances WHERE meeting_id = ? ORDER BY seq_no ASC",
            (meeting_id,),
        ).fetchall()
        b_rows = conn.execute(
            "SELECT * FROM board_items WHERE meeting_id = ? ORDER BY updated_at ASC",
            (meeting_id,),
        ).fetchall()

    board: dict[str, list[dict[str, Any]]] = {c: [] for c in CATEGORIES}
    for r in b_rows:
        cat = r["category"]
        if cat in board:
            board[cat].append(
                {
                    "id": r["id"],
                    "category": cat,
                    "content": r["content"],
                    "is_locked": bool(r["is_locked"]),
                    "carried_over": bool(r["carried_from_meeting_id"]),
                }
            )

    return {
        "meeting": dict(m),
        "utterances": [dict(u) for u in u_rows],
        "board": board,
    }


def add_utterance(
    meeting_id: str, text: str, speaker: str = "参加者", source: str = "manual"
) -> dict[str, Any]:
    uid = str(uuid.uuid4())
    now = _now_iso()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(seq_no), 0) AS max_seq FROM utterances WHERE meeting_id = ?",
            (meeting_id,),
        ).fetchone()
        seq_no = int(row["max_seq"]) + 1
        conn.execute(
            """
            INSERT INTO utterances (id, meeting_id, seq_no, speaker, text, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (uid, meeting_id, seq_no, speaker.strip() or "参加者", text.strip(), source, now),
        )
    return {
        "id": uid,
        "meeting_id": meeting_id,
        "seq_no": seq_no,
        "speaker": speaker.strip() or "参加者",
        "text": text.strip(),
        "source": source,
        "created_at": now,
    }


def sync_board_from_scribe(meeting_id: str, new_board: dict[str, list[str]]) -> dict[str, list[dict[str, Any]]]:
    """Single-Writer原則：手動ロック済み(is_locked=1)の項目は保護し、非ロック項目のみ書記AIの出力で更新する。"""
    now = _now_iso()
    with get_conn() as conn:
        locked_rows = conn.execute(
            "SELECT content FROM board_items WHERE meeting_id = ? AND is_locked = 1",
            (meeting_id,),
        ).fetchall()
        locked_contents = {r["content"].strip() for r in locked_rows}

        carried_rows = conn.execute(
            """
            SELECT content, carried_from_meeting_id
            FROM board_items
            WHERE meeting_id = ? AND is_locked = 0 AND carried_from_meeting_id IS NOT NULL
            """,
            (meeting_id,),
        ).fetchall()
        carried_map = {r["content"].strip(): r["carried_from_meeting_id"] for r in carried_rows}

        conn.execute(
            "DELETE FROM board_items WHERE meeting_id = ? AND is_locked = 0",
            (meeting_id,),
        )

        for cat in CATEGORIES:
            for item_text in new_board.get(cat, []):
                cleaned = str(item_text).strip()
                if not cleaned or cleaned in locked_contents:
                    continue
                conn.execute(
                    """
                    INSERT INTO board_items (id, meeting_id, category, content, is_locked, carried_from_meeting_id, updated_at)
                    VALUES (?, ?, ?, ?, 0, ?, ?)
                    """,
                    (str(uuid.uuid4()), meeting_id, cat, cleaned, carried_map.get(cleaned), now),
                )

    return get_meeting_detail(meeting_id)["board"]


def upsert_manual_board_item(
    meeting_id: str,
    category: str,
    content: str,
    item_id: str | None = None,
    is_locked: bool = True,
) -> dict[str, list[dict[str, Any]]]:
    if category not in CATEGORIES:
        raise ValueError(f"Invalid category: {category}")
    now = _now_iso()
    with get_conn() as conn:
        if item_id:
            conn.execute(
                """
                UPDATE board_items
                SET category = ?, content = ?, is_locked = ?, updated_at = ?
                WHERE id = ? AND meeting_id = ?
                """,
                (category, content.strip(), int(is_locked), now, item_id, meeting_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO board_items (id, meeting_id, category, content, is_locked, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (str(uuid.uuid4()), meeting_id, category, content.strip(), int(is_locked), now),
            )
    return get_meeting_detail(meeting_id)["board"]


def delete_board_item(meeting_id: str, item_id: str) -> dict[str, list[dict[str, Any]]]:
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM board_items WHERE id = ? AND meeting_id = ?",
            (item_id, meeting_id),
        )
    return get_meeting_detail(meeting_id)["board"]


def complete_meeting_summary(meeting_id: str, summary_markdown: str) -> None:
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE meetings
            SET status = 'completed', summary_markdown = ?, ended_at = ?
            WHERE id = ?
            """,
            (summary_markdown, now, meeting_id),
        )


def log_agent_run(
    meeting_id: str, agent_role: str, model_name: str, latency_ms: int, success: bool
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_runs (id, meeting_id, agent_role, model_name, latency_ms, success, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (str(uuid.uuid4()), meeting_id, agent_role, model_name, latency_ms, int(success), _now_iso()),
        )
