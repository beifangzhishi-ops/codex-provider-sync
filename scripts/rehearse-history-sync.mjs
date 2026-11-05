// Run the upstream-style Provider Sync or Restore only against an isolated
// rehearsal Home containing the explicit sentinel files created by the
// snapshot/integrity commands. Never write to a live ~/.codex directory.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { runRestore, runSync } from "../src/service.js";

const [action, target] = process.argv.slice(2);
if (!["sync", "restore"].includes(action) || !target) {
  throw new Error("Usage: node scripts/rehearse-history-sync.mjs sync|restore <lab-home>");
}
const lab = path.resolve(target);
assert.ok(path.basename(lab) === ".local-history-lab", "Refusing to operate outside a known local rehearsal directory");
assert.notEqual(lab.toLowerCase(), path.join(process.env.USERPROFILE || "", ".codex").toLowerCase());
const snapshot = JSON.parse(await fsp.readFile(path.join(lab, ".snapshot-report.json"), "utf8"));
const integrity = JSON.parse(await fsp.readFile(path.join(lab, ".lab-integrity.json"), "utf8"));
assert.equal(snapshot.threadRows, integrity.threads.count, "Missing integrity baseline.");
assert.equal(snapshot.copiedFiles, Object.keys(integrity.files).length, "Missing file integrity baseline.");
const reportPath = path.join(lab, ".lab-sync-report.json");

if (action === "sync") {
  try {
    await fsp.access(reportPath);
    throw new Error("A rehearsal Sync has already been recorded; refusing to run twice.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = await runSync({ codexHome: lab });
  const summary = {
    action,
    partial: result.partial,
    partialReason: result.partialReason,
    changedSessionFiles: result.changedSessionFiles,
    sqliteRowsUpdated: result.sqliteRowsUpdated,
    unconfirmedSessionFiles: result.unconfirmedSessionFiles,
    skippedCount: result.skipSummary?.total ?? 0,
    skippedByReason: (result.skipSummary?.items ?? []).reduce((out, item) => {
      out[item.reason] = (out[item.reason] || 0) + 1;
      return out;
    }, {}),
    backupDir: result.backupDir ?? null
  };
  await fsp.writeFile(reportPath, JSON.stringify(summary, null, 2), { flag: "wx" });
  console.log(JSON.stringify(summary));
  if (result.partial) process.exitCode = 2;
} else {
  const report = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  assert.ok(report.backupDir, "Cannot restore without a recorded UndoBackup");
  const result = await runRestore({ codexHome: lab, backupDir: report.backupDir });
  console.log(JSON.stringify({
    action,
    restoreJournalState: result.restoreJournalState,
    changedSessionFiles: result.changedSessionFiles,
    backupDir: report.backupDir
  }));
  if (result.restoreJournalState !== "completed") process.exitCode = 2;
}
