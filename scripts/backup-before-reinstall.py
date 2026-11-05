"""Make a verified, non-destructive snapshot of the current Codex conversations.

All output stays below this checkout's ignored .local-live-migration directory.
This tool never touches the existing migration backups or the real Codex files.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from uuid import uuid4


ROOT_NAMES = ("sessions", "archived_sessions")
ROOT_METADATA = (
    "config.toml",
    "history.jsonl",
    "session_index.jsonl",
    ".codex-global-state.json",
    ".codex-global-state.json.bak",
)


def digest_file(file_path):
    hash_value = hashlib.sha256()
    with file_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hash_value.update(chunk)
    return hash_value.hexdigest()


def copy_folder(source, destination):
    if not source.is_dir():
        raise RuntimeError(f"Missing history directory: {source}")

    def reject_links(current):
        if current.is_symlink():
            raise RuntimeError("Snapshot refuses symbolic links in history directories")

    for current_dir, dirs, files in os.walk(source):
        base = Path(current_dir)
        reject_links(base)
        target = destination / base.relative_to(source)
        target.mkdir(parents=True, exist_ok=True)
        for directory in dirs:
            reject_links(base / directory)
        for filename in files:
            file = base / filename
            reject_links(file)
            shutil.copy2(file, target / filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path.home() / ".codex")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    expected = Path.home() / ".codex"
    if source != expected.resolve(strict=True):
        parser.error("Only the current user's original Codex Home can be backed up.")

    repo = Path(__file__).resolve().parent.parent
    backup_root = repo / ".local-live-migration"
    backup_root.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = backup_root / f"pre-reinstall-{timestamp}-{uuid4().hex[:8]}"
    destination.mkdir(exist_ok=False)
    history = destination / "codex-home"
    history.mkdir()
    report = {
        "status": "incomplete",
        "snapshotDir": str(destination),
        "createdUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "authJsonCopied": False,
        "liveHomeModified": False,
    }

    try:
        source_db = source / "state_5.sqlite"
        if not source_db.is_file():
            raise RuntimeError("Live State DB not found")
        with sqlite3.connect(str(source_db), timeout=30) as old:
            with sqlite3.connect(str(history / "state_5.sqlite")) as new:
                old.backup(new, pages=512, sleep=0.02)

        for folder in ROOT_NAMES:
            copy_folder(source / folder, history / folder)

        for name in ROOT_METADATA:
            file = source / name
            if file.is_file():
                if file.is_symlink():
                    raise RuntimeError("Refusing symlink for root history metadata")
                shutil.copy2(file, history / name)

        copied_files = [
            p for folder in ROOT_NAMES
            for p in (history / folder).rglob("*") if p.is_file()
        ]
        current_files = {
            str(p.relative_to(source)).lower()
            for folder in ROOT_NAMES
            for p in (source / folder).rglob("*") if p.is_file()
        }
        snapshot_files = {
            str(p.relative_to(history)).lower() for p in copied_files
        }
        copied_session_files = [
            p for p in copied_files if p.name.startswith("rollout-")
            and (p.name.endswith(".jsonl") or p.name.endswith(".jsonl.zst"))
        ]
        failures = 0
        for copied in copied_files:
            live_path = source / copied.relative_to(history)
            if not live_path.is_file() or digest_file(copied) != digest_file(live_path):
                failures += 1
        for name in ROOT_METADATA:
            copied = history / name
            live = source / name
            if copied.is_file() and (
                not live.is_file() or digest_file(copied) != digest_file(live)
            ):
                failures += 1

        with sqlite3.connect(str(history / "state_5.sqlite")) as copied_db:
            copied_db.row_factory = sqlite3.Row
            if copied_db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite snapshot failed integrity_check")
            copied_threads = [
                tuple(row) for row in copied_db.execute("SELECT * FROM threads ORDER BY id")
            ]
        with sqlite3.connect(f"file:{source_db.as_posix()}?mode=ro", uri=True) as live_db:
            live_threads = [
                tuple(row) for row in live_db.execute("SELECT * FROM threads ORDER BY id")
            ]
        db_matches = copied_threads == live_threads
        file_lists_match = current_files == snapshot_files
        report.update({
            "status": "verified" if failures == 0 and db_matches and file_lists_match else "incomplete",
            "copiedSessionFiles": len(copied_session_files),
            "copiedFilesInHistoryFolders": len(copied_files),
            "sqliteThreads": len(copied_threads),
            "filesNotMatchingLive": failures,
            "fileListsMatchLive": file_lists_match,
            "sqliteThreadsMatchLive": db_matches,
            "totalBackupBytes": sum(p.stat().st_size for p in history.rglob("*") if p.is_file()),
        })
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        (destination / "backup-report.json").write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] == "verified" else 2


if __name__ == "__main__":
    sys.exit(main())
