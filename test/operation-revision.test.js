import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureBackupRevision,
  captureConfigRevision,
  captureOperationRevisions,
  captureRolloutRevision,
  captureStateDbRevision,
  revisionMismatch
} from "../src/operation-revision.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-sync-revision-"));
  const codexHome = path.join(root, ".codex");
  const sqliteHome = path.join(codexHome, "sqlite");
  const stateDbPath = path.join(sqliteHome, "state_5.sqlite");
  const rolloutPath = path.join(codexHome, "sessions", "2026", "08", "rollout-a.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.mkdir(sqliteHome, { recursive: true });
  await fs.writeFile(rolloutPath, '{"type":"session_meta"}\n', "utf8");
  await fs.writeFile(stateDbPath, "db-one", "utf8");
  const storage = {
    codexHome,
    sqliteHome,
    sqliteHomeSource: "default",
    sqliteAccess: { supported: true, reason: null },
    allowLegacyRootFallback: true,
    stateDbLocation: { path: stateDbPath, source: "sqlite-dir" }
  };
  return { root, codexHome, rolloutPath, stateDbPath, storage };
}

test("operation revisions detect exact config, rollout, and State DB drift", async () => {
  const value = await fixture();
  try {
    const first = await captureOperationRevisions({
      codexHome: value.codexHome,
      profileRevision: "profile-r1",
      configText: 'model_provider = "openai"\n',
      storage: value.storage
    });
    assert.equal(first.rolloutScanComplete, true);
    assert.equal(first.rolloutFileCount, 1);

    await fs.writeFile(value.rolloutPath, '{"type":"session_meta","changed":true}\n', "utf8");
    const rolloutChanged = await captureOperationRevisions({
      codexHome: value.codexHome,
      profileRevision: "profile-r1",
      configText: 'model_provider = "openai"\n',
      storage: value.storage
    });
    assert.equal(revisionMismatch(first, rolloutChanged), "rollout");

    const configChanged = { ...first, configRevision: captureConfigRevision("changed") };
    assert.equal(revisionMismatch(first, configChanged), "config");

    const dbBefore = await captureStateDbRevision(value.storage);
    await fs.writeFile(value.stateDbPath, "db-two", "utf8");
    const dbAfter = await captureStateDbRevision(value.storage);
    assert.notEqual(dbAfter, dbBefore);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("content revisions ignore transient SQLite WAL-index and empty WAL but detect durable WAL and DB changes", async () => {
  const value = await fixture();
  try {
    const first = await captureStateDbRevision(value.storage);
    // SQLite read-only connections can create these files, even though the DB
    // is unchanged. They must not invalidate a just-prepared Restore.
    await fs.writeFile(`${value.stateDbPath}-wal`, Buffer.alloc(0));
    await fs.writeFile(`${value.stateDbPath}-shm`, Buffer.alloc(32768, 5));
    const afterEmpty = await captureStateDbRevision(value.storage);
    assert.equal(afterEmpty, first);
    await fs.writeFile(`${value.stateDbPath}-shm`, Buffer.alloc(32768, 7));
    assert.equal(await captureStateDbRevision(value.storage), first);
    await fs.rm(`${value.stateDbPath}-wal`);
    await fs.rm(`${value.stateDbPath}-shm`);
    assert.equal(await captureStateDbRevision(value.storage), first);

    // A non-empty WAL carries actual transaction data and must be protected.
    await fs.writeFile(`${value.stateDbPath}-wal`, Buffer.from("real WAL contents"));
    const withWal = await captureStateDbRevision(value.storage);
    assert.notEqual(withWal, first);
    await fs.writeFile(`${value.stateDbPath}-wal`, Buffer.from("changed WAL bytes"));
    assert.notEqual(await captureStateDbRevision(value.storage), withWal);
    await fs.rm(`${value.stateDbPath}-wal`);
    assert.equal(await captureStateDbRevision(value.storage), first);

    await fs.writeFile(value.stateDbPath, "db-content-changed", "utf8");
    assert.notEqual(await captureStateDbRevision(value.storage), first);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("rollout and managed backup revisions are deterministic and content-bound", async () => {
  const value = await fixture();
  const backupDir = path.join(value.codexHome, "backups_state", "provider-sync", "fixture");
  try {
    const rolloutOne = await captureRolloutRevision(value.codexHome);
    const rolloutTwo = await captureRolloutRevision(value.codexHome);
    assert.deepEqual(rolloutTwo, rolloutOne);

    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, "metadata.json"), '{"namespace":"provider-sync"}', "utf8");
    const backupOne = await captureBackupRevision(backupDir);
    await fs.writeFile(path.join(backupDir, "metadata.json"), '{"namespace":"provider-sync","changed":true}', "utf8");
    const backupTwo = await captureBackupRevision(backupDir);
    assert.notEqual(backupTwo, backupOne);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("metadata rollout revisions avoid body reads while detecting file metadata drift", async () => {
  const value = await fixture();
  let rolloutBodyReads = 0;
  const fsImpl = {
    ...fs,
    async readFile(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(value.rolloutPath)) {
        rolloutBodyReads += 1;
        throw new Error("rollout body read sentinel");
      }
      return fs.readFile(filePath, ...args);
    }
  };
  try {
    const first = await captureRolloutRevision(value.codexHome, { fsImpl, mode: "metadata" });
    assert.equal(first.rolloutScanComplete, true);
    assert.equal(rolloutBodyReads, 0);

    await fs.appendFile(value.rolloutPath, '{"type":"event_msg"}\n', "utf8");
    const second = await captureRolloutRevision(value.codexHome, { fsImpl, mode: "metadata" });
    assert.notEqual(second.revision, first.revision);
    assert.equal(rolloutBodyReads, 0);

    await assert.rejects(
      captureRolloutRevision(value.codexHome, { fsImpl }),
      /rollout body read sentinel/
    );
    assert.equal(rolloutBodyReads, 1);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});
