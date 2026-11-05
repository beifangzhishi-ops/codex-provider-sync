// Verify the managed SQLite backup can be restored independently without
// changing the source or touching any real Codex Home.
// Usage: node scripts/rehearse-history-backup-probe.mjs <lab-home>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { openDatabase } from "../src/sqlite.js";
import { restoreSqliteOnlineBackup } from "../src/sqlite-state.js";
import { captureRestoreSourceIdentity } from "../src/restore-v2.js";

const lab = path.resolve(process.argv[2] ?? "");
const repo = path.resolve(import.meta.dirname, "..");
assert.equal(path.basename(lab), ".local-history-lab");
assert.equal(path.dirname(lab).toLowerCase(), repo.toLowerCase());
assert.notEqual(lab.toLowerCase(), path.join(process.env.USERPROFILE ?? "", ".codex").toLowerCase());

const metadata = JSON.parse(await fs.readFile(path.join(lab, ".lab-sync-report.json"), "utf8"));
const baseline = JSON.parse(await fs.readFile(path.join(lab, ".lab-integrity.json"), "utf8"));
const sourceRoot = path.resolve(metadata.backupDir);
assert.equal(path.dirname(sourceRoot).toLowerCase(),
  path.join(lab, "backups_state", "provider-sync").toLowerCase());
const source = path.join(sourceRoot, "db", "sqlite-home", "state_5.sqlite");
const destination = path.join(lab, ".restore-db-only-probe.sqlite");
await fs.access(source);
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    await fs.access(destination + suffix);
    throw new Error("Refusing to replace existing database probe data.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
    : value;
const before = await captureRestoreSourceIdentity(sourceRoot);
try {
  await restoreSqliteOnlineBackup(source, destination);
  const after = await captureRestoreSourceIdentity(sourceRoot);
  assert.equal(after, before, "Restore mutated the source managed backup.");

  const db = await openDatabase(destination, { readOnly: true, immutableSnapshot: true });
  let rows;
  try {
    rows = db.prepare("SELECT * FROM threads ORDER BY id").all();
  } finally {
    db.close();
  }
  const counts = {};
  for (const row of rows) counts[row.model_provider] = (counts[row.model_provider] ?? 0) + 1;
  const nonProviderHash = hash(JSON.stringify(rows.map(row => {
    const copy = { ...row };
    delete copy.model_provider;
    return canonical(copy);
  })));
  assert.equal(rows.length, baseline.threads.count);
  assert.deepEqual(counts, baseline.threads.providerCounts);
  assert.equal(nonProviderHash, baseline.threads.nonProviderHash);
  console.log(JSON.stringify({
    success: true, sourceBackupUnchanged: true, threadCount: rows.length,
    providers: counts, nonProviderFieldsUnchanged: true,
    destination: "temporary probe database (removed after verification)"
  }));
} finally {
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.rm(destination + suffix, { force: true });
  }
}
