// Run the upstream-style Provider Sync or Restore only against an isolated
// rehearsal Home containing the explicit sentinel files created by the
// snapshot/integrity commands. Never write to a live ~/.codex directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { applyRestore, prepareRestore, runRestore, runSync } from "../src/service.js";

const [action, target] = process.argv.slice(2);
if (!["sync", "restore", "restore-diagnostic"].includes(action) || !target) {
  throw new Error("Usage: node scripts/rehearse-history-sync.mjs sync|restore|restore-diagnostic <lab-home>");
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
} else if (action === "restore-diagnostic") {
  const report = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  assert.ok(report.backupDir, "Cannot diagnose restore without an UndoBackup.");
  const auditPath = path.join(lab, ".lab-restore-diagnostic.jsonl");
  const auditHandle = await fsp.open(auditPath, "wx");
  const stamp = event => JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n";
  const writeAudit = event => fs.appendFileSync(auditPath, stamp(event));
  await auditHandle.close();
  let latestStage = null;
  const onProgress = event => {
    if (event?.stage !== latestStage || event?.status === "complete") {
      latestStage = event.stage;
      writeAudit({
        event: "restore-progress",
        stage: String(event.stage ?? ""),
        status: String(event.status ?? ""),
        count: Number(event.count ?? 0)
      });
    }
  };
  // Keep an observable, local-only checkpoint if an approval worker stops
  // before the command can flush its final stdout.
  let elapsed = 0;
  const heartbeat = setInterval(() => {
    elapsed += 10;
    writeAudit({ event: "heartbeat", seconds: elapsed, stage: latestStage });
  }, 10_000);
  try {
    writeAudit({ event: "begin", backup: path.basename(report.backupDir) });
    const plan = await prepareRestore({ codexHome: lab, backupDir: report.backupDir, onProgress });
    writeAudit({ event: "prepared", planIdAvailable: Boolean(plan.planId), impact: plan.impact });
    const result = (await applyRestore({ schemaVersion: 1, planId: plan.planId })).result;
    writeAudit({ event: "completed", restoreJournalState: result.restoreJournalState });
    console.log(JSON.stringify({ action, auditPath, restoreJournalState: result.restoreJournalState }));
    if (result.restoreJournalState !== "completed") process.exitCode = 2;
  } catch (error) {
    writeAudit({
      event: "error",
      name: String(error?.name ?? ""),
      code: String(error?.code ?? ""),
      message: String(error?.message ?? error),
      cause: String(error?.cause?.message ?? "")
    });
    console.error(JSON.stringify({
      action, auditPath, status: "failed", code: error?.code,
      message: error?.message, cause: error?.cause?.message
    }));
    process.exitCode = 2;
  } finally {
    clearInterval(heartbeat);
  }
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
