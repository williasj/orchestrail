# -*- coding: utf-8 -*-
"""
BulletTrain Section 13 acceptance fixture.

Writes hand-built run directories into the BulletTrain control plane so the
UI tab can be exercised with NO supervisor and NO model in the loop. If the
tab renders these correctly, the storage contract and the display layer are
proven, and anything that misbehaves later is the agent loop.

Creates three projects, each exercising a different display path:

  bt-fixture-done      current_run null, last_run 001, state done
                       -> one-shot poll, Start run enabled, Download visible
                          and serving a real zip

  bt-fixture-halted    current_run null, last_run 002, state halted
                       -> halt_reason suffix on state, error line under the
                          blocked task, all six task marks on screen,
                          Download hidden

  bt-fixture-running   current_run 001, state running, phase session
                       -> 3-second poll loop stays alive, Start run disabled
                          and labelled "Run in progress..."

Nothing here spawns a supervisor. startSupervisorInBackground only runs on
POST /runs, so a fixture with current_run set just looks busy; it is inert.

Usage (as root on the TrueNAS host):

    python3 bt_fixture.py                 # create fixtures
    python3 bt_fixture.py --remove        # delete them again
    python3 bt_fixture.py --base /some/other/projects

Default base is the bind-mounted control plane:
    /mnt/tempapp/APPS/local-agentic-team/bullettrain/projects
"""

import argparse
import io
import json
import os
import shutil
import zipfile
from datetime import datetime, timedelta, timezone

DEFAULT_BASE = "/mnt/tempapp/APPS/local-agentic-team/bullettrain/projects"

SLUGS = ["bt-fixture-done", "bt-fixture-halted", "bt-fixture-running"]

# Mirrors BT_DEFAULT_RUNTIME in src/bullettrain/config.ts. Key order matches
# renderRuntimeMd, which iterates Object.entries of the runtime object.
RUNTIME_KEYS = [
    "model",
    "endpoint",
    "num_ctx",
    "temperature",
    "soft_checkpoint_pct",
    "hard_kill_pct",
    "max_turns_per_session",
    "max_sessions",
    "max_tasks",
    "max_attempts_per_task",
    "stall_sessions",
    "wall_clock_hours",
    "exec_timeout_ms",
]

RUNTIME = {
    "model": "qwen3-coder-next:iq3",
    "endpoint": "http://localhost:11434/v1",
    "num_ctx": 65536,
    "temperature": 0.6,
    "soft_checkpoint_pct": 65,
    "hard_kill_pct": 80,
    "max_turns_per_session": 60,
    "max_sessions": 200,
    "max_tasks": 60,
    "max_attempts_per_task": 3,
    "stall_sessions": 8,
    "wall_clock_hours": 12,
    "exec_timeout_ms": 300000,
}


def iso(offset_minutes=0):
    t = datetime.now(timezone.utc) + timedelta(minutes=offset_minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(content, bytes) else "w"
    kwargs = {} if isinstance(content, bytes) else {"encoding": "utf-8"}
    with open(path, mode, **kwargs) as f:
        f.write(content)


def render_runtime_md(runtime):
    """Matches renderRuntimeMd in src/bullettrain/runtime.ts."""
    lines = ["---"]
    for k in RUNTIME_KEYS:
        lines.append("%s: %s" % (k, runtime[k]))
    lines.append("---")
    return "\n".join(lines) + "\n"


def render_tasks_md(tasks):
    """
    Matches renderTasksMd in src/bullettrain/store.ts exactly.

    The parser is strict: the header is '- [M] NNN title' with a 3-digit id,
    and every field line is indented exactly six spaces. Field order here
    follows the renderer so the fixture round-trips through parseTasksMd
    byte-for-byte identically to something the supervisor would have written.
    """
    lines = ["# tasks", ""]
    for t in tasks:
        lines.append("- [%s] %s %s" % (t["mark"], t["id"], t["title"]))
        lines.append("      verify: %s" % t["verify"])
        if t.get("depends"):
            lines.append("      depends: %s" % ",".join(t["depends"]))
        lines.append("      attempts: %d" % t.get("attempts", 0))
        if t.get("artifacts"):
            lines.append("      artifacts: %s" % ", ".join(t["artifacts"]))
        if t.get("error"):
            lines.append("      error: %s" % t["error"])
        if t.get("parent"):
            lines.append("      parent: %s" % t["parent"])
        lines.append("")
    return "\n".join(lines)


def make_status(slug, run, state, **over):
    status = {
        "schema": 1,
        "slug": slug,
        "run": run,
        "state": state,
        "phase": None,
        "pid": None,
        "started_at": iso(-90),
        "updated_at": iso(-1),
        "ended_at": None,
        "halt_reason": None,
        "runtime": dict(RUNTIME),
        "current_task": None,
        "session_no": 0,
        "counters": {
            "tasks_total": 0,
            "tasks_verified": 0,
            "tasks_blocked": 0,
            "tasks_manual": 0,
            "sessions_run": 0,
            "replans": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "wall_seconds": 0,
        },
        "last_verify": None,
        "git_head": None,
        "message": "",
    }
    counters = over.pop("counters", None)
    if counters:
        status["counters"].update(counters)
    status.update(over)
    return status


def make_session(n, task, end_reason, turns, tool_calls, ctx_pct, commits):
    return {
        "n": n,
        "task": task,
        "started_at": iso(-90 + n * 10),
        "ended_at": iso(-85 + n * 10),
        "end_reason": end_reason,
        "turns": turns,
        "tool_calls": tool_calls,
        "prompt_tokens_peak": 12000 + n * 900,
        "ctx_pct_peak": ctx_pct,
        "handoff_written": True,
        "commits": commits,
        "nap_turns": 0,
    }


def make_zip():
    """A small but real zip, so the Download button resolves instead of 404."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "README.md",
            "# bt-fixture-done\n\n"
            "Placeholder deliverable written by the Section 13 acceptance\n"
            "fixture. No agent produced this.\n",
        )
        z.writestr(
            "src/app.py",
            "# -*- coding: utf-8 -*-\n\n\ndef main():\n"
            '    print("fixture deliverable")\n\n\n'
            'if __name__ == "__main__":\n    main()\n',
        )
    return buf.getvalue()


# -- Project builders ---------------------------------------------------------


def build_done(base):
    slug = "bt-fixture-done"
    run = "001"
    root = os.path.join(base, slug)
    run_root = os.path.join(root, "runs", run)

    write(
        os.path.join(root, "project.json"),
        json.dumps(
            {
                "slug": slug,
                "title": "Fixture: completed run",
                "created_at": iso(-240),
                "runs": 1,
                "current_run": None,
                "last_run": run,
                "workspace_run_id": "bt-" + slug,
            },
            indent=2,
        ),
    )

    brief = (
        "# Fixture: completed run\n\n"
        "Hand-built acceptance fixture. Every task verified, deliverable\n"
        "packaged. Exercises the terminal-done display path.\n"
    )
    write(os.path.join(root, "PROJECT.md"), brief)
    write(os.path.join(root, "RUNTIME.md"), render_runtime_md(RUNTIME))
    write(
        os.path.join(root, "DECISIONS.md"),
        "2026-09-18 run 001  Chose stdlib http.server over Flask to avoid a "
        "dependency for two routes.\n"
        "2026-09-18 run 001  Config via environment variables, no config file.\n",
    )
    write(os.path.join(run_root, "BRIEF.md"), brief)

    tasks = [
        {
            "id": "001",
            "mark": "x",
            "title": "Scaffold project layout and entrypoint",
            "verify": "test -f src/app.py",
            "depends": [],
            "attempts": 1,
            "artifacts": ["src/app.py"],
        },
        {
            "id": "002",
            "mark": "x",
            "title": "Implement request handler",
            "verify": "python3 -m pytest tests/test_handler.py -q",
            "depends": ["001"],
            "attempts": 2,
            "artifacts": ["src/handler.py", "tests/test_handler.py"],
        },
        {
            "id": "003",
            "mark": "x",
            "title": "Add README and usage docs",
            "verify": "test -s README.md",
            "depends": ["002"],
            "attempts": 1,
            "artifacts": ["README.md"],
        },
    ]
    write(os.path.join(run_root, "tasks.md"), render_tasks_md(tasks))

    write(
        os.path.join(run_root, "HANDOFF.md"),
        "All three tasks verified. Deliverable packaged at deliverable.zip.\n"
        "Nothing outstanding.\n",
    )
    write(
        os.path.join(run_root, "report.md"),
        "# Run 001 report\n\n"
        "State: done\n\n"
        "3 of 3 tasks verified across 4 sessions. No blocked tasks, no\n"
        "replans. Deliverable packaged.\n",
    )

    status = make_status(
        slug,
        run,
        "done",
        phase=None,
        ended_at=iso(-2),
        current_task=None,
        session_no=4,
        counters={
            "tasks_total": 3,
            "tasks_verified": 3,
            "sessions_run": 4,
            "prompt_tokens": 61400,
            "completion_tokens": 14800,
            "wall_seconds": 5280,
        },
        last_verify={
            "task": "003",
            "exit_code": 0,
            "at": iso(-3),
            "log": "verify/003.1.log",
        },
        git_head="a3f19c2",
        message="Run complete: 3/3 tasks verified, deliverable packaged.",
    )
    write(os.path.join(run_root, "status.json"), json.dumps(status, indent=2))

    for rec in [
        make_session(1, "001", "task_complete", 6, 9, 31, ["a1b2c3d"]),
        make_session(2, "002", "soft_checkpoint", 22, 41, 67, ["b2c3d4e"]),
        make_session(3, "002", "task_complete", 14, 26, 44, ["c3d4e5f"]),
        make_session(4, "003", "task_complete", 5, 7, 22, ["a3f19c2"]),
    ]:
        write(
            os.path.join(run_root, "sessions", "%03d.json" % rec["n"]),
            json.dumps(rec, indent=2),
        )

    write(
        os.path.join(run_root, "verify", "001.1.log"),
        "+ test -f src/app.py\nexit 0\n",
    )
    write(
        os.path.join(run_root, "verify", "002.1.log"),
        "+ python3 -m pytest tests/test_handler.py -q\n"
        "F\n1 failed in 0.14s\nexit 1\n",
    )
    write(
        os.path.join(run_root, "verify", "002.2.log"),
        "+ python3 -m pytest tests/test_handler.py -q\n"
        "....\n4 passed in 0.19s\nexit 0\n",
    )
    write(
        os.path.join(run_root, "verify", "003.1.log"),
        "+ test -s README.md\nexit 0\n",
    )

    write(os.path.join(run_root, "deliverable.zip"), make_zip())
    return slug


def build_halted(base):
    slug = "bt-fixture-halted"
    run = "002"
    root = os.path.join(base, slug)
    run_root = os.path.join(root, "runs", run)

    write(
        os.path.join(root, "project.json"),
        json.dumps(
            {
                "slug": slug,
                "title": "Fixture: halted run, all six task marks",
                "created_at": iso(-600),
                "runs": 2,
                "current_run": None,
                "last_run": run,
                "workspace_run_id": "bt-" + slug,
            },
            indent=2,
        ),
    )

    brief = (
        "# Fixture: halted run\n\n"
        "Exercises every task mark the renderer knows about, plus the\n"
        "halt_reason suffix and the per-task error line.\n"
    )
    write(os.path.join(root, "PROJECT.md"), brief)
    write(os.path.join(root, "RUNTIME.md"), render_runtime_md(RUNTIME))
    write(
        os.path.join(root, "DECISIONS.md"),
        "2026-09-18 run 001  Postgres over SQLite: concurrent writers expected.\n"
        "2026-09-18 run 002  Dropped the websocket path, polling is sufficient.\n",
    )
    write(os.path.join(run_root, "BRIEF.md"), brief)

    # One task per mark, so BT_MARK_LABEL and BT_MARK_COLOR are fully covered.
    tasks = [
        {
            "id": "001",
            "mark": "x",
            "title": "Database schema and migrations",
            "verify": "python3 -m pytest tests/test_schema.py -q",
            "depends": [],
            "attempts": 1,
            "artifacts": ["migrations/001_init.sql"],
        },
        {
            "id": "002",
            "mark": ">",
            "title": "Connection pool wiring",
            "verify": "python3 -m pytest tests/test_pool.py -q",
            "depends": ["001"],
            "attempts": 1,
            "artifacts": [],
        },
        {
            "id": "003",
            "mark": "!",
            "title": "Integration test against live database",
            "verify": "python3 -m pytest tests/test_integration.py -q",
            "depends": ["002"],
            "attempts": 3,
            "artifacts": [],
            "error": "attempt cap reached: connection refused on 127.0.0.1:5432, "
            "no database reachable from the exec sandbox",
        },
        {
            "id": "004",
            "mark": "?",
            "title": "Provision production credentials",
            "verify": "manual",
            "depends": [],
            "attempts": 0,
            "artifacts": [],
        },
        {
            "id": "005",
            "mark": " ",
            "title": "Backup and restore runbook",
            "verify": "test -s docs/RUNBOOK.md",
            "depends": ["003"],
            "attempts": 0,
            "artifacts": [],
        },
        {
            "id": "006",
            "mark": "-",
            "title": "Websocket notification channel",
            "verify": "python3 -m pytest tests/test_ws.py -q",
            "depends": [],
            "attempts": 0,
            "artifacts": [],
        },
    ]
    write(os.path.join(run_root, "tasks.md"), render_tasks_md(tasks))

    write(
        os.path.join(run_root, "HANDOFF.md"),
        "Blocked on 003: the exec sandbox has no route to a database. 002 was\n"
        "mid-flight when the halt fired. 004 needs a human. 006 abandoned per\n"
        "the run 002 decision line.\n",
    )
    write(
        os.path.join(run_root, "report.md"),
        "# Run 002 report\n\n"
        "State: halted (all_blocked)\n\n"
        "1 of 6 tasks verified. 003 exhausted its attempt cap and everything\n"
        "downstream depends on it. 004 is queued for manual handling.\n",
    )

    status = make_status(
        slug,
        run,
        "halted",
        phase="verify",
        ended_at=iso(-5),
        halt_reason="all_blocked",
        current_task="003",
        session_no=11,
        counters={
            "tasks_total": 6,
            "tasks_verified": 1,
            "tasks_blocked": 1,
            "tasks_manual": 1,
            "sessions_run": 11,
            "replans": 1,
            "prompt_tokens": 184300,
            "completion_tokens": 41900,
            "wall_seconds": 14760,
        },
        last_verify={
            "task": "003",
            "exit_code": 1,
            "at": iso(-6),
            "log": "verify/003.3.log",
        },
        git_head="7e4d180",
        message="Halted: 003 blocked after 3 attempts and 005 depends on it.",
    )
    write(os.path.join(run_root, "status.json"), json.dumps(status, indent=2))

    for rec in [
        make_session(1, "001", "task_complete", 8, 12, 29, ["1a2b3c4"]),
        make_session(2, "002", "soft_checkpoint", 31, 58, 68, ["2b3c4d5"]),
        make_session(9, "003", "hard_kill", 44, 81, 82, []),
        make_session(10, "003", "turn_cap", 60, 97, 71, ["7e4d180"]),
        make_session(11, "003", "nap_detected", 3, 0, 18, []),
    ]:
        write(
            os.path.join(run_root, "sessions", "%03d.json" % rec["n"]),
            json.dumps(rec, indent=2),
        )

    write(
        os.path.join(run_root, "verify", "001.1.log"),
        "+ python3 -m pytest tests/test_schema.py -q\n"
        "...\n3 passed in 0.22s\nexit 0\n",
    )
    for attempt in (1, 2, 3):
        write(
            os.path.join(run_root, "verify", "003.%d.log" % attempt),
            "+ python3 -m pytest tests/test_integration.py -q\n"
            "E   psycopg2.OperationalError: connection to server at "
            '"127.0.0.1", port 5432 failed: Connection refused\n'
            "1 error in 0.31s\nexit 1\n",
        )
    return slug


def build_running(base):
    slug = "bt-fixture-running"
    run = "001"
    root = os.path.join(base, slug)
    run_root = os.path.join(root, "runs", run)

    write(
        os.path.join(root, "project.json"),
        json.dumps(
            {
                "slug": slug,
                "title": "Fixture: run in progress",
                "created_at": iso(-45),
                "runs": 1,
                "current_run": run,
                "last_run": run,
                "workspace_run_id": "bt-" + slug,
            },
            indent=2,
        ),
    )

    brief = (
        "# Fixture: run in progress\n\n"
        "current_run is set, so the tab polls every three seconds and the\n"
        "Start run button stays disabled. No supervisor is attached; the\n"
        "numbers never move. That is the expected result.\n"
    )
    write(os.path.join(root, "PROJECT.md"), brief)
    write(os.path.join(root, "RUNTIME.md"), render_runtime_md(RUNTIME))
    write(os.path.join(root, "DECISIONS.md"), "")
    write(os.path.join(run_root, "BRIEF.md"), brief)

    tasks = [
        {
            "id": "001",
            "mark": "x",
            "title": "Parse the M3U playlist format",
            "verify": "python3 -m pytest tests/test_parse.py -q",
            "depends": [],
            "attempts": 1,
            "artifacts": ["src/parser.py", "tests/test_parse.py"],
        },
        {
            "id": "002",
            "mark": ">",
            "title": "Channel filtering by group tag",
            "verify": "python3 -m pytest tests/test_filter.py -q",
            "depends": ["001"],
            "attempts": 1,
            "artifacts": [],
        },
        {
            "id": "003",
            "mark": " ",
            "title": "XMLTV generation from filtered set",
            "verify": "python3 -m pytest tests/test_xmltv.py -q",
            "depends": ["002"],
            "attempts": 0,
            "artifacts": [],
        },
        {
            "id": "004",
            "mark": " ",
            "title": "Package as a container image",
            "verify": "test -f Dockerfile",
            "depends": ["003"],
            "attempts": 0,
            "artifacts": [],
        },
    ]
    write(os.path.join(run_root, "tasks.md"), render_tasks_md(tasks))

    write(
        os.path.join(run_root, "HANDOFF.md"),
        "001 verified. Working 002: the group-title attribute is not always\n"
        "present, falling back to the channel name prefix when absent.\n",
    )

    status = make_status(
        slug,
        run,
        "running",
        phase="session",
        pid=1,
        current_task="002",
        session_no=3,
        counters={
            "tasks_total": 4,
            "tasks_verified": 1,
            "sessions_run": 2,
            "prompt_tokens": 38200,
            "completion_tokens": 9100,
            "wall_seconds": 2640,
        },
        last_verify={
            "task": "001",
            "exit_code": 0,
            "at": iso(-20),
            "log": "verify/001.1.log",
        },
        git_head="9c02fae",
        message="Session 3: implementing group-tag filtering.",
    )
    write(os.path.join(run_root, "status.json"), json.dumps(status, indent=2))

    for rec in [
        make_session(1, "001", "task_complete", 9, 15, 34, ["4d5e6f7"]),
        make_session(2, "002", "soft_checkpoint", 27, 49, 66, ["9c02fae"]),
    ]:
        write(
            os.path.join(run_root, "sessions", "%03d.json" % rec["n"]),
            json.dumps(rec, indent=2),
        )

    write(
        os.path.join(run_root, "verify", "001.1.log"),
        "+ python3 -m pytest tests/test_parse.py -q\n"
        ".....\n5 passed in 0.17s\nexit 0\n",
    )
    return slug


# -- Entry point --------------------------------------------------------------


def remove(base):
    removed = []
    for slug in SLUGS:
        target = os.path.join(base, slug)
        if os.path.isdir(target):
            shutil.rmtree(target)
            removed.append(slug)
    if removed:
        print("Removed: " + ", ".join(removed))
    else:
        print("Nothing to remove under " + base)


def main():
    ap = argparse.ArgumentParser(description="BulletTrain Section 13 fixture")
    ap.add_argument("--base", default=DEFAULT_BASE, help="projects directory")
    ap.add_argument("--remove", action="store_true", help="delete the fixtures")
    args = ap.parse_args()

    if args.remove:
        remove(args.base)
        return

    os.makedirs(args.base, exist_ok=True)
    for builder in (build_done, build_halted, build_running):
        slug = builder(args.base)
        print("Created " + os.path.join(args.base, slug))

    print("")
    print("Reload the BulletTrain tab. Expected:")
    print("  bt-fixture-done      Start run enabled, Download visible, 3/3")
    print("  bt-fixture-halted    state 'halted (all_blocked)', 6 marks, 1/6")
    print("  bt-fixture-running   Start run disabled, polls every 3s, 1/4")
    print("")
    print("Remove with: python3 " + os.path.basename(__file__) + " --remove")


if __name__ == "__main__":
    main()
