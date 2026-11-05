import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { openDatabase } from "../src/sqlite.js";
import { applySessionChanges, collectProviderChanges, collectSessionChanges, collectStatusRolloutMetadata } from "../src/session-files.js";
import { runRestore, runSync } from "../src/service.js";

const zstdSupported = typeof zstdCompressSync === "function" && typeof zstdDecompressSync === "function";

async function createFixture(t, { walMode = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zstd-sync-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, "archived_sessions"), { recursive: true });
  await fs.mkdir(path.join(home, "sqlite"), { recursive: true });
  await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "openai"\n');

  const inputs = [
    { id: "compressed-current", provider: "OpenAI", archived: false, zipped: true, separator: "\r\n" },
    { id: "compressed-archived", provider: "deepseek", archived: true, zipped: true, separator: "\n" },
    { id: "plain-current", provider: "cpa", archived: false, zipped: false, separator: "\n" }
  ];
  const original = new Map();
  const paths = new Map();
  const dbPath = path.join(home, "sqlite", "state_5.sqlite");
  const db = await openDatabase(dbPath);
  try {
    if (walMode) db.exec("PRAGMA journal_mode=WAL");
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT,
      archived INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 100,
      cwd TEXT, first_user_message TEXT DEFAULT 'fixture'
    )`);
    for (const item of inputs) {
      const folder = item.archived ? "archived_sessions" : "sessions";
      const rawName = `rollout-${item.id}.jsonl`;
      const file = path.join(home, folder, rawName + (item.zipped ? ".zst" : ""));
      const header = JSON.stringify({
        type: "session_meta", payload: {
          id: item.id, model_provider: item.provider, cwd: "/old/project", custom: "keep me"
        }
      });
      const body = [
        '{"type":"response_item","payload":{"text":"\u4e2d\u6587 / escaped \\\\ / SECRET_KEEP_IN_BODY"}}',
        '{"type":"turn_context","payload":{"model":"original-model"}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"a" }}'
      ].join(item.separator) + item.separator;
      const bytes = Buffer.from(header + item.separator + body);
      await fs.writeFile(file, item.zipped ? zstdCompressSync(bytes) : bytes);
      paths.set(item.id, file);
      original.set(item.id, bytes);
      // Existing Codex indexes still refer to the uncompressed .jsonl path.
      db.prepare("INSERT INTO threads(id, model_provider, rollout_path, archived) VALUES (?, ?, ?, ?)")
        .run(item.id, item.provider, path.join(home, folder, rawName), Number(item.archived));
    }
  } finally {
    db.close();
  }
  return { home, dbPath, original, paths };
}

async function rolloutBytes(filePath) {
  const bytes = await fs.readFile(filePath);
  return filePath.endsWith(".zst") ? zstdDecompressSync(bytes) : bytes;
}

test("compressed session metadata is indexed, synchronized and restored without changing body", { skip: !zstdSupported }, async t => {
  const fixture = await createFixture(t);
  const originalMtimes = new Map();
  for (const [id, file] of fixture.paths) originalMtimes.set(id, (await fs.stat(file)).mtimeMs);

  const status = await collectStatusRolloutMetadata(fixture.home, { targetProvider: "openai" });
  assert.equal(status.providerChangeCandidates.length, 3);
  const result = await runSync({ codexHome: fixture.home });
  assert.equal(result.partial, false, JSON.stringify(result));
  assert.equal(result.changedSessionFiles, 3, JSON.stringify(result));
  assert.equal(result.sqliteProviderRowsUpdated, 3);
  assert.ok(result.backupDir);

  const db = await openDatabase(fixture.dbPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT DISTINCT model_provider FROM threads").all().map(row => row.model_provider), ["openai"]);
  } finally {
    db.close();
  }
  for (const [id, file] of fixture.paths) {
    const bytes = await rolloutBytes(file);
    const original = fixture.original.get(id);
    assert.equal(JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()).payload.model_provider, "openai");
    assert.deepEqual(bytes.subarray(bytes.indexOf(10) + 1), original.subarray(original.indexOf(10) + 1));
    assert.ok(Math.abs((await fs.stat(file)).mtimeMs - originalMtimes.get(id)) < 1500);
    if (file.endsWith(".zst")) assert.equal((await fs.readFile(file)).subarray(0, 4).toString("hex"), "28b52ffd");
  }

  const restored = await runRestore({ backupDir: result.backupDir, codexHome: fixture.home });
  assert.equal(restored.restoreJournalState, "completed", JSON.stringify(restored));
  for (const [id, file] of fixture.paths) assert.deepEqual(await rolloutBytes(file), fixture.original.get(id));
});

test("Restore of WAL-mode compressed history never writes SQLite sidecars inside its managed source backup", { skip: !zstdSupported }, async t => {
  const fixture = await createFixture(t, { walMode: true });
  const result = await runSync({ codexHome: fixture.home });
  assert.equal(result.partial, false, JSON.stringify(result));
  const sourceDb = path.join(result.backupDir, "db", "sqlite-home", "state_5.sqlite");
  const sourceFiles = () => fs.readdir(path.dirname(sourceDb));
  assert.deepEqual(await sourceFiles(), ["state_5.sqlite"]);
  assert.equal((await fs.readFile(sourceDb))[18], 2, "WAL mode is retained in the standalone backup");

  const restored = await runRestore({ codexHome: fixture.home, backupDir: result.backupDir });
  assert.equal(restored.restoreJournalState, "completed", JSON.stringify(restored));
  assert.deepEqual(await sourceFiles(), ["state_5.sqlite"], "Restore must not change its own source backup");
  for (const [id, file] of fixture.paths) {
    assert.deepEqual(await rolloutBytes(file), fixture.original.get(id));
  }
});

test("immutable snapshot reads reject a managed source with a nonempty WAL", { skip: !zstdSupported }, async t => {
  const fixture = await createFixture(t, { walMode: true });
  const result = await runSync({ codexHome: fixture.home });
  const sourceDb = path.join(result.backupDir, "db", "sqlite-home", "state_5.sqlite");
  const wal = `${sourceDb}-wal`;
  await fs.writeFile(wal, Buffer.from("uncommitted WAL payload"));
  await assert.rejects(
    openDatabase(sourceDb, { readOnly: true, immutableSnapshot: true }),
    /nonempty or invalid WAL/
  );
  await assert.rejects(
    runRestore({ codexHome: fixture.home, backupDir: result.backupDir }),
    error => error?.code === "BACKUP_FAILED"
      && /nonempty or invalid WAL/.test(String(error?.cause?.message))
  );
});

test("compressed file changed after preparation is skipped, not overwritten", { skip: !zstdSupported }, async t => {
  const fixture = await createFixture(t);
  const scan = await collectProviderChanges(fixture.home, "openai");
  assert.equal(scan.changes.length, 3);
  const file = fixture.paths.get("compressed-current");
  const changed = Buffer.from(JSON.stringify({
    type: "session_meta", payload: { id: "compressed-current", model_provider: "another-provider" }
  }) + "\n" + "other body\n");
  await fs.writeFile(file, zstdCompressSync(changed));
  const result = await applySessionChanges(scan.changes.filter(change => change.path === file));
  assert.deepEqual(result.skippedPaths, [file]);
  assert.deepEqual(await rolloutBytes(file), changed);
});

test("direct compressed first-line application", { skip: !zstdSupported }, async t => {
  const fixture = await createFixture(t);
  const scan = await collectProviderChanges(fixture.home, "openai");
  const changes = scan.changes.filter(change => change.path.endsWith(".zst"));
  assert.equal(changes.length, 2);
  const result = await applySessionChanges(changes);
  assert.equal(result.appliedChanges, 2);
});

test("malformed Zstandard headers are skipped without changing their SQLite ownership", { skip: !zstdSupported }, async t => {
  const value = await createFixture(t);
  const corrupted = value.paths.get("compressed-current");
  await fs.writeFile(corrupted, Buffer.from("invalid zstd stream"));
  const before = await fs.readFile(corrupted);
  const status = await collectStatusRolloutMetadata(value.home);
  assert.equal(status.skippedItems.length, 1);
  assert.equal(status.skippedItems[0].reason, "metadata-invalid");
  const result = await runSync({ codexHome: value.home });
  assert.equal(result.partial, true);
  assert.ok(result.skipSummary.items.some(item => item.path === corrupted));
  const db = await openDatabase(value.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT model_provider FROM threads WHERE id='compressed-current'").get().model_provider, "OpenAI");
    assert.equal(db.prepare("SELECT model_provider FROM threads WHERE id='compressed-archived'").get().model_provider, "openai");
  } finally {
    db.close();
  }
  assert.deepEqual(await fs.readFile(corrupted), before);
});

test("model repair does not partially edit compressed rollout metadata", { skip: !zstdSupported }, async t => {
  const value = await createFixture(t);
  const scan = await collectSessionChanges(value.home, "openai", {
    targetModel: "new-model", includeModels: true, includeUserEvent: false, includeEncryptedContent: false
  });
  assert.ok(scan.skippedItems.some(item =>
    item.path === value.paths.get("compressed-current") && item.reason === "compressed-model-unsupported"));
  assert.ok(scan.skippedItems.some(item =>
    item.path === value.paths.get("compressed-archived") && item.reason === "compressed-model-unsupported"));
  assert.ok(scan.changes.every(item => !item.path.endsWith(".zst")));
});

test("paginated session with multiple compressed owners follows an old SQLite .jsonl path", { skip: !zstdSupported }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zstd-paginated-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, "archived_sessions"), { recursive: true });
  await fs.mkdir(path.join(home, "sqlite"), { recursive: true });
  await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "openai"\n');
  const files = [
    path.join(home, "sessions", "rollout-shared.jsonl.zst"),
    path.join(home, "archived_sessions", "rollout-shared-child.jsonl.zst")
  ];
  for (const file of files) {
    const header = JSON.stringify({
      type: "session_meta",
      payload: { id: "shared", model_provider: "OpenAI", history_mode: "paginated" }
    });
    await fs.writeFile(file, zstdCompressSync(Buffer.from(header + '\n' + '{"type":"event_msg","payload":{"message":"unchanged"}}\n')));
  }
  const dbPath = path.join(home, "sqlite", "state_5.sqlite");
  const db = await openDatabase(dbPath);
  try {
    db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, archived INTEGER DEFAULT 0)");
    db.prepare("INSERT INTO threads(id,model_provider,rollout_path) VALUES (?,?,?)")
      .run("shared", "OpenAI", files[0].slice(0, -4));
  } finally {
    db.close();
  }
  const result = await runSync({ codexHome: home });
  assert.equal(result.partial, false, JSON.stringify(result));
  assert.equal(result.changedSessionFiles, 2);
  assert.equal(result.sqliteProviderRowsUpdated, 1);
  for (const file of files) {
    assert.equal(JSON.parse((await rolloutBytes(file)).toString().split('\n')[0]).payload.model_provider, "openai");
  }
  await runRestore({ codexHome: home, backupDir: result.backupDir });
  for (const file of files) {
    assert.equal(JSON.parse((await rolloutBytes(file)).toString().split('\n')[0]).payload.model_provider, "OpenAI");
  }
});
