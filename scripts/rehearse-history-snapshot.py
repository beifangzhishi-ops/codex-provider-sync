"""Create an isolated, consistent Codex history rehearsal copy.

Never run this against a destination that already exists. The source Codex
Home is opened for SQLite backup and read-only file copies, never modified.
No credentials are copied; the rehearsal config is a synthetic one.
"""
import argparse
import collections
import json
import pathlib
import shutil
import sqlite3
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    args = parser.parse_args()
    src = args.source.resolve(strict=True)
    dst = args.destination.resolve(strict=False)
    if dst.exists():
        parser.error(f"Refusing to replace an existing rehearsal: {dst}")
    if dst == src or src in dst.parents and dst.parts[: len(src.parts)] == src.parts:
        parser.error("Rehearsal must not be inside the real Codex Home.")
    if not (src / "state_5.sqlite").is_file():
        parser.error("Source root State DB is missing.")

    dst.mkdir(parents=True, exist_ok=False)
    # The backup API obtains a consistent SQLite snapshot even in WAL mode.
    original = sqlite3.connect(str(src / "state_5.sqlite"), timeout=20)
    replica = sqlite3.connect(str(dst / "state_5.sqlite"), timeout=20)
    try:
        original.backup(replica, pages=512, sleep=0.03)
    finally:
        original.close()
        replica.close()

    for dirname in ("sessions", "archived_sessions"):
        if (src / dirname).is_dir():
            shutil.copytree(src / dirname, dst / dirname, copy_function=shutil.copy2)
        else:
            (dst / dirname).mkdir()

    for filename in (".codex-global-state.json", ".codex-global-state.json.bak", "session_index.jsonl"):
        if (src / filename).is_file():
            shutil.copy2(src / filename, dst / filename)

    (dst / "config.toml").write_text('model_provider = "openai"\n', encoding="utf-8")

    db = sqlite3.connect(dst / "state_5.sqlite")
    db.row_factory = sqlite3.Row
    try:
        rows = list(db.execute("SELECT id, rollout_path, model_provider, cwd FROM threads"))
        provider_counts = collections.Counter(row["model_provider"] for row in rows)
        updates = []
        for row in rows:
            old_path = row["rollout_path"]
            normalized = old_path[4:] if old_path.startswith("\\\\?\\") else old_path
            old = pathlib.Path(normalized)
            try:
                relative = old.relative_to(src)
            except ValueError:
                raise RuntimeError("SQLite thread points outside the expected Codex Home") from None
            if relative.parts[0] not in ("sessions", "archived_sessions"):
                raise RuntimeError("Unexpected rollout path outside sessions/archived_sessions")
            new_path = dst / relative
            if not (new_path.is_file() or pathlib.Path(str(new_path) + ".zst").is_file()):
                raise RuntimeError("A copied rollout is missing")
            updates.append((str(new_path), row["id"]))
        with db:
            db.executemany("UPDATE threads SET rollout_path = ? WHERE id = ?", updates)
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Copied State DB integrity_check failed")
        snapshot = {
            "threadRows": len(rows),
            "indexedProviders": dict(provider_counts),
            "rebasedRolloutPaths": len(updates),
            "copiedFiles": sum(1 for d in ("sessions", "archived_sessions") for p in (dst / d).rglob("rollout-*.jsonl*")),
        }
        (dst / ".snapshot-report.json").write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        print(json.dumps(snapshot))
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
