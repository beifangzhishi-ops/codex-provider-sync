# ADR-0049: Zstandard-compressed rollout metadata synchronization

Status: Proposed (source branch; not yet an upstream release).

## Problem

Codex history may be archived as `rollout-*.jsonl.zst`. Before this change,
provider discovery, preparation, and backup validation considered only plain
`.jsonl`. Existing SQLite rows can still reference the old `.jsonl` path,
so updating SQLite alone can silently disagree with compressed session metadata.

## Decision

- Recognize both plain and compressed rollout names in all Provider inventories,
  revision capture, SQLite association, and allowed Restore targets.
- Require Node.js 24 native streaming Zstandard for compressed files only.
- Decompress only a bounded session header during Status/Provider preparation.
- Rewrite the compressed stream through a staged file, replacing only the
  decoded session metadata line; copy subsequent decoded bytes without parsing.
- Revalidate source file identity before atomic replacement and fsync staged
  content. Keep the original mtime, thread ID and project path.
- Restore original provider metadata from the UndoBackup through the same
  streaming codec. Compare restored *decoded* body bytes, not compressed bytes.
- Treat a stored `.jsonl` SQLite path as an alias for a matching `.jsonl.zst`
  path only after existing thread-identity safeguards.

## Boundaries

- The compressed writer does not support history model-field modifications.
- This does not make Codex Desktop / Remote capable of opening compressed
  session files by itself. No index paths are rewritten merely to imply that.
- No changes to authentication, sessions or migration status without a
  separately authorized execution against a copy of user data.

## Evidence

During full-history Restore on Windows, SQLite inspection can create a
zero-byte WAL and a 32 KiB `-shm` after Prepare, without changing any durable
DB bytes. Previously the content revision fingerprint included those
non-authoritative files and incorrectly rejected Apply with
`STALE_STATE: state-db`. Content revision now protects the main DB and every
nonempty WAL, while normalizing the empty WAL and excluding the WAL-index.
This is not a relaxation for modified thread data: substantive database
changes still invalidate prepared operations.

In a second Restore failure, the same read-only SQLite connection opened the
WAL-mode **managed backup source** and created empty WAL/SHM sidecars within
the source backup. The restore source revision then changed during its own
pre-snapshot, correctly blocking the operation. For standalone managed
snapshot *sources only*, SQLite now opens with `mode=ro&immutable=1` URI,
which prevents auxiliary files from being created. Restore must still verify
the complete backup source identity before and after staging; do not ignore
new files in managed backup revision checks.

Run `node --test test/zstd-provider-sync.test.js` and the existing Provider
revision / backup / Restore regression suites on a supported Node.js runtime.
