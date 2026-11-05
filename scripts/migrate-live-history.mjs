// Production, explicit, one-shot Provider-only migration of Codex history.
// The backup phase only reads ~/.codex, and writes to this repository's
// ignored .local-live-migration directory. The migrate phase modifies live
// history only after an independently verified backup is present.
// Usage: node scripts/migrate-live-history.mjs backup|migrate|audit
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSqliteOnlineBackup } from "../src/sqlite-state.js";
import { findPendingTransactions } from "../src/transaction-journal.js";
import { runSync } from "../src/service.js";
import { runHistoryIntegrity } from "./rehearse-history-integrity.mjs";

const action = process.argv[2];
if (!["backup", "migrate", "audit"].includes(action)) {
  throw new Error("Expected backup|migrate|audit.");
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveHome = path.join(os.homedir(), ".codex");
const privateRoot = path.join(repo, ".local-live-migration");
const readyPath = path.join(privateRoot, "latest-ready.json");
const normalized = filePath => path.resolve(filePath).toLowerCase();

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
}

function emit(stage, details = {}) {
  console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...details }));
}

async function requireLiveHome() {
  assert.equal(normalized(liveHome), normalized(path.join(process.env.USERPROFILE ?? "", ".codex")));
  for (const relative of ["config.toml", "state_5.sqlite", "sessions", "archived_sessions"]) {
    await fs.access(path.join(liveHome, relative));
  }
  const cfg = await fs.readFile(path.join(liveHome, "config.toml"), "utf8");
  const topLevel = cfg.split(/^\s*\[/m)[0];
  assert.match(topLevel, /^\s*model_provider\s*=\s*["']openai["']\s*$/m,
    "The active provider must be the built-in lowercase openai.");
  const realHome = await fs.realpath(liveHome);
  assert.equal(normalized(realHome), normalized(liveHome), "Unexpected Codex Home redirection.");
}

async function loadReady() {
  const metadata = JSON.parse(await fs.readFile(readyPath, "utf8"));
  const backupDir = path.resolve(metadata.backupDir);
  assert.equal(normalized(path.dirname(backupDir)), normalized(privateRoot));
  assert.equal(metadata.liveHome.toLowerCase(), liveHome.toLowerCase());
  assert.equal(metadata.state, "ready");
  assert.equal(await exists(path.join(backupDir, "codex-home", ".lab-integrity.json")), true);
  return { metadata, backupDir, manifestFile: path.join(backupDir, "codex-home", ".lab-integrity.json") };
}

await requireLiveHome();

if (action === "backup") {
  await fs.mkdir(privateRoot, { recursive: true });
  assert.equal(await exists(readyPath), false, "A ready live-history backup already exists.");
  const backupDir = path.join(privateRoot,
    `backup-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}-${randomUUID().slice(0, 8)}`);
  const snapshotHome = path.join(backupDir, "codex-home");
  await fs.mkdir(snapshotHome, { recursive: true });
  emit("backup-start", { backupDir, authCopied: false });

  // The official SQLite online-backup interface guarantees a transactionally
  // consistent snapshot of WAL-mode databases; copying the live SQLite file
  // alone would not.
  const db = await createSqliteOnlineBackup({
    stateDbLocation: { path: path.join(liveHome, "state_5.sqlite"), source: "live-history-snapshot" }
  }, path.join(snapshotHome, "state_5.sqlite"));
  assert.equal(db.databasePresent, true);
  emit("sqlite-snapshot", { present: true });

  for (const folder of ["sessions", "archived_sessions"]) {
    await fs.cp(path.join(liveHome, folder), path.join(snapshotHome, folder), {
      recursive: true, preserveTimestamps: true, force: false, errorOnExist: true,
      filter: async source => {
        const stat = await fs.lstat(source);
        assert.ok(!stat.isSymbolicLink(), "A historical session directory contains a symbolic link.");
        return true;
      }
    });
    emit("copied-folder", { folder });
  }
  // Credentials are intentionally excluded. Everything that Provider-only
  // migration can touch or reference is covered by the snapshot and manifest.
  for (const filename of [
    "config.toml", ".codex-global-state.json", ".codex-global-state.json.bak",
    "session_index.jsonl", "history.jsonl"
  ]) {
    const original = path.join(liveHome, filename);
    if (!(await exists(original))) continue;
    const stat = await fs.lstat(original);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const destination = path.join(snapshotHome, filename);
    await fs.copyFile(original, destination, fs.constants.COPYFILE_EXCL);
    await fs.utimes(destination, stat.atime, stat.mtime);
  }

  const manifestFile = path.join(snapshotHome, ".lab-integrity.json");
  const baseline = await runHistoryIntegrity({ action: "capture", home: snapshotHome, manifestFile });
  emit("backup-baseline", { fileCount: baseline.fileCount, threadCount: baseline.threadCount });
  const comparison = await runHistoryIntegrity({ action: "restore", home: liveHome, manifestFile });
  emit("backup-verified", { ok: comparison.ok, fileCount: comparison.fileCount, threadCount: comparison.threadCount });
  if (!comparison.ok) {
    throw new Error("The copied backup does not match the current live history. Nothing was migrated.");
  }
  const pending = await findPendingTransactions(liveHome);
  assert.equal(pending.length, 0, "An unfinished live history transaction must be resolved first.");
  const metadata = {
    state: "ready", createdAt: new Date().toISOString(), liveHome, backupDir,
    rawHistoryFileCount: baseline.fileCount, sqliteThreadCount: baseline.threadCount,
    originalSqliteProviders: baseline.providers, authCopied: false,
    historicalSessionFilesAreByteForByteCopies: true
  };
  await writeJson(path.join(backupDir, "backup-ready.json"), metadata);
  await writeJson(readyPath, metadata);
  emit("backup-ready", { backupDir, fileCount: baseline.fileCount, threadCount: baseline.threadCount });
} else if (action === "migrate") {
  const { metadata, backupDir, manifestFile } = await loadReady();
  const attemptPath = path.join(backupDir, "migration-attempt.json");
  assert.equal(await exists(attemptPath), false, "Migration was already attempted against this backup.");
  const before = await runHistoryIntegrity({ action: "restore", home: liveHome, manifestFile });
  emit("preflight", { ok: before.ok, fileCount: before.fileCount, providers: before.providers });
  assert.ok(before.ok, "Live history differs from the backed-up baseline; refusing mutation.");
  assert.equal(before.fileCount, metadata.rawHistoryFileCount);
  assert.equal(before.threadCount, metadata.sqliteThreadCount);
  const pending = await findPendingTransactions(liveHome);
  assert.equal(pending.length, 0, "Live history already has unfinished transactions.");
  const baseline = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const candidates = Object.values(baseline.files).filter(x => x.provider !== "openai").length;
  await writeJson(attemptPath, { initiatedAt: new Date().toISOString(), candidates, backupDir });
  emit("sync-start", { candidates });
  try {
    const synced = await runSync({ codexHome: liveHome });
    emit("sync-finished", {
      partial: synced.partial, changedSessionFiles: synced.changedSessionFiles,
      sqliteRowsUpdated: synced.sqliteRowsUpdated, skipped: synced.skipSummary?.total ?? 0
    });
    const verification = await runHistoryIntegrity({ action: "verify", home: liveHome, manifestFile });
    const successful = verification.ok && !synced.partial
      && synced.changedSessionFiles === candidates && !(synced.skipSummary?.total > 0);
    const report = {
      state: successful ? "verified" : "incomplete",
      at: new Date().toISOString(), candidates,
      changedSessionFiles: synced.changedSessionFiles,
      sqliteRowsUpdated: synced.sqliteRowsUpdated,
      skippedCount: synced.skipSummary?.total ?? 0,
      partial: Boolean(synced.partial),
      managedUndoBackup: synced.backupDir ?? null, verification,
      independentBackup: backupDir
    };
    await writeJson(path.join(backupDir, "migration-result.json"), report);
    emit("migration-result", report);
    if (!successful) process.exitCode = 2;
  } catch (error) {
    await writeJson(path.join(backupDir, "migration-error.json"), {
      at: new Date().toISOString(), code: String(error?.code ?? ""),
      message: String(error?.message ?? error), backupDir
    });
    throw error;
  }
} else {
  const { backupDir, manifestFile } = await loadReady();
  const result = await runHistoryIntegrity({ action: "verify", home: liveHome, manifestFile });
  const pending = await findPendingTransactions(liveHome);
  emit("live-audit", { ...result, pendingTransactions: pending.length, backupDir });
  if (!result.ok || pending.length) process.exitCode = 2;
}
