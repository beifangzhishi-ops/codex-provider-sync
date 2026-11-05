// Independent, content-preserving verification of a Codex history rehearsal.
// Usage: node scripts/rehearse-history-integrity.mjs capture|verify|restore <lab-home>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const [action, labArgument] = process.argv.slice(2);
if (!["capture", "verify", "restore"].includes(action) || !labArgument) {
  throw new Error("Expected capture|verify|restore and a rehearsal Home path.");
}
const lab = path.resolve(labArgument);
const manifestFile = path.join(lab, ".lab-integrity.json");

async function filesBelow(dir) {
  const files = [];
  async function walk(folder) {
    for (const item of await fsp.readdir(folder, { withFileTypes: true })) {
      const abs = path.join(folder, item.name);
      if (item.isDirectory()) await walk(abs);
      else if (item.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(item.name)) files.push(abs);
      else if (item.isSymbolicLink()) throw new Error("Unsafe symbolic link in rehearsal.");
    }
  }
  await walk(dir);
  return files;
}

const sha256 = value => createHash("sha256").update(value).digest("hex");

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalizeJson(value[key])]));
  }
  return value;
}

function snapshotThreads() {
  const db = new DatabaseSync(path.join(lab, "state_5.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM threads ORDER BY id").all();
    const nonProviderRows = rows.map(row => {
      const copy = { ...row };
      delete copy.model_provider;
      return canonicalizeJson(copy);
    });
    const providers = {};
    for (const row of rows) providers[row.model_provider] = (providers[row.model_provider] ?? 0) + 1;
    return {
      count: rows.length,
      nonProviderHash: sha256(JSON.stringify(nonProviderRows)),
      providerCounts: providers
    };
  } finally {
    db.close();
  }
}

async function fileFingerprint(filePath) {
  const input = fs.createReadStream(filePath);
  const stream = filePath.endsWith(".zst") ? input.pipe(zlib.createZstdDecompress()) : input;
  const body = createHash("sha256");
  let headerChunks = [];
  let headerSize = 0;
  let foundHeader = false;
  let decodedBodyBytes = 0;
  try {
    for await (const chunk of stream) {
      if (!foundHeader) {
        const index = chunk.indexOf(0x0a);
        if (index === -1) {
          headerChunks.push(chunk);
          headerSize += chunk.length;
          if (headerSize > 128 * 1024 * 1024) throw new Error("Oversized session header");
          continue;
        }
        headerChunks.push(chunk.subarray(0, index));
        const firstLine = Buffer.concat(headerChunks).toString("utf8").replace(/\r$/, "");
        const record = JSON.parse(firstLine);
        assert.equal(record.type, "session_meta");
        const provider = record.payload.model_provider;
        delete record.payload.model_provider;
        const head = {
          provider,
          id: record.payload.id,
          otherMetadataHash: sha256(JSON.stringify(canonicalizeJson(record)))
        };
        foundHeader = head;
        headerChunks = [];
        const rest = chunk.subarray(index + 1);
        body.update(rest);
        decodedBodyBytes += rest.length;
      } else {
        body.update(chunk);
        decodedBodyBytes += chunk.length;
      }
    }
    assert.ok(foundHeader, "Missing session_meta JSONL");
    return { ...foundHeader, bodyHash: body.digest("hex"), decodedBodyBytes };
  } finally {
    stream.destroy();
    input.destroy();
  }
}

const sourceFiles = [
  ...(await filesBelow(path.join(lab, "sessions"))),
  ...(await filesBelow(path.join(lab, "archived_sessions")))
].sort();
const all = {};
let cursor = 0;
const workers = Array.from({ length: 4 }, async () => {
  while (cursor < sourceFiles.length) {
    const index = cursor++;
    const filePath = sourceFiles[index];
    const relativePath = path.relative(lab, filePath).replaceAll("\\", "/");
    all[relativePath] = await fileFingerprint(filePath);
  }
});
await Promise.all(workers);

const data = { files: all, threads: snapshotThreads() };
if (action === "capture") {
  await fsp.writeFile(manifestFile, JSON.stringify(data), { flag: "wx" });
  console.log(JSON.stringify({
    action, fileCount: Object.keys(data.files).length,
    threadCount: data.threads.count, providers: data.threads.providerCounts,
    integrityManifest: manifestFile
  }));
} else {
  const original = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
  const result = {
    action, fileCount: Object.keys(data.files).length,
    threadCount: data.threads.count, providers: data.threads.providerCounts,
    missing: 0, extra: 0, bodyChanged: 0, otherHeaderChanged: 0,
    unexpectedProvider: 0, dbNonProviderChanged: original.threads.nonProviderHash !== data.threads.nonProviderHash
  };
  for (const [name, previous] of Object.entries(original.files)) {
    const current = data.files[name];
    if (!current) { result.missing++; continue; }
    if (current.bodyHash !== previous.bodyHash || current.decodedBodyBytes !== previous.decodedBodyBytes) result.bodyChanged++;
    if (current.otherMetadataHash !== previous.otherMetadataHash || current.id !== previous.id) result.otherHeaderChanged++;
    const expectedProvider = action === "restore" ? previous.provider : "openai";
    if (current.provider !== expectedProvider) result.unexpectedProvider++;
  }
  result.extra = Object.keys(data.files).filter(name => !original.files[name]).length;
  if (action === "verify" && (Object.keys(data.threads.providerCounts).some(name => name !== "openai")
      || data.threads.count !== original.threads.count)) result.dbProviderMismatch = true;
  if (action === "restore" && JSON.stringify(data.threads.providerCounts) !== JSON.stringify(original.threads.providerCounts)) {
    result.dbProviderMismatch = true;
  }
  const fail = result.missing || result.extra || result.bodyChanged || result.otherHeaderChanged
    || result.unexpectedProvider || result.dbNonProviderChanged || result.dbProviderMismatch;
  console.log(JSON.stringify(result));
  if (fail) process.exitCode = 2;
}
