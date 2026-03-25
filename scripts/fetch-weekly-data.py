#!/usr/bin/env python3
"""
Tier 0 script for the weekly-retro pipeline.

Fetches retrospective data from nanoclaw's SQLite database and logs,
then outputs WorkItem[] JSON to stdout. Empty output (or []) means
no items — pipeline stops at Tier 0 with $0 cost.

Data sources:
  1. Pipeline cost — aggregate triage_events spend from past 7 days
  2. Task run errors — failed task runs from past 7 days
  3. Task run stats — summary of all task runs from past 7 days
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

# nanoclaw stores its database at data/nanoclaw.db relative to project root
DATA_DIR = os.environ.get(
    "NANOCLAW_DATA_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"),
)
DB_PATH = os.path.join(DATA_DIR, "nanoclaw.db")


def get_db() -> sqlite3.Connection | None:
    """Open nanoclaw's SQLite database, or None if unavailable."""
    if not os.path.exists(DB_PATH):
        return None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def fetch_pipeline_costs(conn: sqlite3.Connection, since: str) -> list[dict]:
    """Aggregate pipeline triage costs from the past week."""
    items = []
    now = datetime.now(timezone.utc).isoformat()

    try:
        row = conn.execute(
            """
            SELECT
                COUNT(*) as event_count,
                COALESCE(SUM(cost_estimate), 0) as total_cost,
                COALESCE(AVG(cost_estimate), 0) as avg_cost
            FROM triage_events
            WHERE timestamp >= ?
            """,
            (since,),
        ).fetchone()

        if row and row["event_count"] > 0:
            items.append({
                "id": "cost-pipeline-weekly",
                "source": "nanoclaw/triage_events",
                "type": "cost",
                "summary": (
                    f"Pipeline triage: {row['event_count']} events, "
                    f"${row['total_cost']:.4f} total, "
                    f"${row['avg_cost']:.4f} avg"
                ),
                "metadata": {
                    "eventCount": row["event_count"],
                    "totalCost": round(row["total_cost"], 4),
                    "avgCost": round(row["avg_cost"], 4),
                },
                "timestamp": now,
            })
    except sqlite3.Error:
        pass

    return items


def fetch_task_errors(conn: sqlite3.Connection, since: str) -> list[dict]:
    """Fetch failed task runs from the past week."""
    items = []

    try:
        rows = conn.execute(
            """
            SELECT
                tr.task_id,
                tr.run_at,
                tr.duration_ms,
                tr.error,
                t.prompt
            FROM task_runs tr
            LEFT JOIN tasks t ON t.id = tr.task_id
            WHERE tr.status = 'error' AND tr.run_at >= ?
            ORDER BY tr.run_at DESC
            LIMIT 20
            """,
            (since,),
        ).fetchall()

        for row in rows:
            prompt = row["prompt"] or "unknown"
            prompt_short = prompt[:60] + "..." if len(prompt) > 60 else prompt
            items.append({
                "id": f"error-{row['task_id']}-{row['run_at']}",
                "source": "nanoclaw/task_runs",
                "type": "error",
                "summary": f"Task {row['task_id']} failed: {row['error'][:100]}",
                "body": f"Prompt: {prompt_short}\nError: {row['error']}\nDuration: {row['duration_ms']}ms",
                "metadata": {
                    "taskId": row["task_id"],
                    "durationMs": row["duration_ms"],
                },
                "timestamp": row["run_at"],
            })
    except sqlite3.Error:
        pass

    return items


def fetch_task_stats(conn: sqlite3.Connection, since: str) -> list[dict]:
    """Summarize task run stats for the past week."""
    items = []
    now = datetime.now(timezone.utc).isoformat()

    try:
        row = conn.execute(
            """
            SELECT
                COUNT(*) as total_runs,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
                COUNT(DISTINCT task_id) as unique_tasks
            FROM task_runs
            WHERE run_at >= ?
            """,
            (since,),
        ).fetchone()

        if row and row["total_runs"] > 0:
            success_rate = (
                row["success_count"] / row["total_runs"] * 100
                if row["total_runs"] > 0
                else 0
            )
            items.append({
                "id": "stats-tasks-weekly",
                "source": "nanoclaw/task_runs",
                "type": "stats",
                "summary": (
                    f"Task runs: {row['total_runs']} total, "
                    f"{row['success_count']} success, "
                    f"{row['error_count']} errors "
                    f"({success_rate:.0f}% success rate), "
                    f"{row['unique_tasks']} unique tasks, "
                    f"{row['avg_duration_ms']:.0f}ms avg duration"
                ),
                "metadata": {
                    "totalRuns": row["total_runs"],
                    "successCount": row["success_count"],
                    "errorCount": row["error_count"],
                    "successRate": round(success_rate, 1),
                    "uniqueTasks": row["unique_tasks"],
                    "avgDurationMs": round(row["avg_duration_ms"]),
                },
                "timestamp": now,
            })
    except sqlite3.Error:
        pass

    return items


def main():
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    all_items: list[dict] = []

    conn = get_db()
    if conn:
        try:
            all_items.extend(fetch_pipeline_costs(conn, since))
            all_items.extend(fetch_task_errors(conn, since))
            all_items.extend(fetch_task_stats(conn, since))
        finally:
            conn.close()

    json.dump(all_items, sys.stdout)


if __name__ == "__main__":
    main()
