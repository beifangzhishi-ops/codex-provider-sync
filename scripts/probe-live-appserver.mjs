// Read-only Codex App Server verification after a successful live migration.
// Does not start, resume, fork or modify any thread.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statusPath = path.join(projectRoot, ".local-live-migration", "latest-ready.json");
const status = JSON.parse(readFileSync(statusPath, "utf8"));
assert.equal(status.state, "ready");
assert.equal(path.resolve(status.liveHome).toLowerCase(),
  path.join(os.homedir(), ".codex").toLowerCase());
const report = JSON.parse(readFileSync(path.join(status.backupDir, "migration-result.json"), "utf8"));
assert.equal(report.state, "verified", "Do not inspect via App Server before migration verification.");
const binary = process.argv[2] ?? path.join(os.homedir(),
  "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
assert.ok(path.isAbsolute(binary) && existsSync(binary), "Codex executable not found.");

const snapshotDb = new DatabaseSync(path.join(status.backupDir, "codex-home", "state_5.sqlite"),
  { readOnly: true });
let originalIndexedCount;
const examples = [];
try {
  const rows = snapshotDb.prepare("SELECT id, model_provider, rollout_path FROM threads").all();
  originalIndexedCount = rows.length;
  for (const r of rows) {
    if (r.model_provider === "openai") continue;
    const saved = String(r.rollout_path ?? "");
    const compressed = saved.endsWith(".zst") || existsSync(`${saved}.zst`);
    if (!compressed) continue;
    const archived = saved.includes("archived_sessions");
    if (examples.some(x => x.archived === archived)) continue;
    examples.push({ id: String(r.id), archived });
    if (examples.length === 2) break;
  }
  assert.ok(examples.length > 0, "No compressed originally non-openai indexed threads found.");
} finally {
  snapshotDb.close();
}

const child = spawn(binary, ["app-server"], {
  cwd: projectRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
});
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let sequence = 0;
let stopped = false;
let stderrBytes = 0;
child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
function closeWith(error) {
  if (stopped) return;
  stopped = true;
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}
child.on("error", error => closeWith(error));
child.on("exit", code => closeWith(new Error(`Codex App Server ended: ${code}`)));
rl.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) {
    entry.reject(new Error(`App Server RPC error ${message.error.code}: ${message.error.message}`));
  } else {
    entry.resolve(message.result);
  }
});
function rpc(method, params = {}) {
  assert.ok(!stopped);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`App Server response timeout for ${method}`));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ method, id, params }) + "\n");
  });
}
async function pageThreads(options) {
  let cursor = null;
  let pageCount = 0;
  let total = 0;
  let seenExampleIds = new Set();
  do {
    const params = { ...options, limit: 100 };
    if (cursor !== null) params.cursor = cursor;
    const page = await rpc("thread/list", params);
    assert.ok(Array.isArray(page.data));
    total += page.data.length;
    for (const thread of page.data) {
      if (examples.some(sample => sample.id === thread.id)) seenExampleIds.add(thread.id);
    }
    cursor = page.nextCursor ?? null;
    pageCount++;
    assert.ok(pageCount <= 100, "Unexpected number of thread listing pages.");
  } while (cursor);
  return { total, pages: pageCount, indexedOriginalExamplesListed: seenExampleIds.size };
}

try {
  await rpc("initialize", {
    clientInfo: { name: "provider_sync_read_only_check", title: "Provider Sync Read-only Check", version: "1.0.0" }
  });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const defaultListing = await pageThreads({ useStateDbOnly: true });
  const allSources = [
    "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
    "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"
  ];
  const allSourceListing = await pageThreads({
    useStateDbOnly: true, modelProviders: ["openai"], sourceKinds: allSources
  });
  const reads = [];
  for (const sample of examples) {
    try {
      const result = await rpc("thread/read", { threadId: sample.id });
      reads.push({ archived: sample.archived, readable: result?.thread?.id === sample.id });
    } catch (error) {
      reads.push({
        archived: sample.archived, readable: false,
        reason: String(error.message).slice(0, 140)
      });
    }
  }
  console.log(JSON.stringify({
    appServerConnected: true, apiReadsOnly: true,
    indexedThreadsInOriginalBackup: originalIndexedCount,
    defaultActiveListing: defaultListing,
    allInteractiveSourcesListing: allSourceListing,
    originalCompressedExamples: reads,
    note: "App Server local API validation is not a Codex Remote UI validation."
  }));
} finally {
  rl.close();
  child.stdin.end();
  child.kill();
}
