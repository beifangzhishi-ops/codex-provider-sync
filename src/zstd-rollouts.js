import fs from "node:fs";
import fsp from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

// Compression is optional for ordinary JSONL on older Node runtimes. Both
// native Zstandard streams are available on the Node 24 runtimes used by Codex.
export function isZstdRollout(filePath) {
  return typeof filePath === "string" && filePath.endsWith(".jsonl.zst");
}

function requireZstd() {
  if (typeof zlib.createZstdDecompress !== "function"
      || typeof zlib.createZstdCompress !== "function") {
    throw new Error("Compressed Codex rollouts require Node.js 24 or newer with native Zstandard support.");
  }
}

export function openZstdRollout(filePath) {
  requireZstd();
  const source = fs.createReadStream(filePath);
  const decoder = zlib.createZstdDecompress();
  source.on("error", error => decoder.destroy(error));
  decoder.on("close", () => source.destroy());
  return source.pipe(decoder);
}

// Do not decompress an entire rollout just to read its bounded session_meta.
export async function readZstdRolloutHeader(filePath, maxBytes = Number.POSITIVE_INFINITY) {
  const input = openZstdRollout(filePath);
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of input) {
      const newline = chunk.indexOf(0x0a);
      const take = newline === -1 ? chunk.length : newline + 1;
      chunks.push(chunk.subarray(0, take));
      length += take;
      if (length > maxBytes + 2) {
        const error = new Error("Compressed rollout session metadata exceeds the header limit.");
        error.name = "RolloutMetadataLimitError";
        throw error;
      }
      if (newline !== -1) break;
    }
    const bytes = Buffer.concat(chunks, length);
    const newline = bytes.indexOf(0x0a);
    const crlf = newline > 0 && bytes[newline - 1] === 0x0d;
    const header = newline === -1 ? bytes : bytes.subarray(0, newline - (crlf ? 1 : 0));
    if (header.length > maxBytes) {
      const error = new Error("Compressed rollout session metadata exceeds the header limit.");
      error.name = "RolloutMetadataLimitError";
      throw error;
    }
    return {
      bytes: header,
      separator: newline === -1 ? "" : crlf ? "\r\n" : "\n",
      offset: bytes.length
    };
  } catch (error) {
    if (/^(ZSTD_|ERR_ZSTD)/.test(String(error?.code ?? ""))) {
      const invalid = new Error("Compressed Codex rollout has an invalid Zstandard stream.", { cause: error });
      invalid.name = "RolloutZstdDecodingError";
      throw invalid;
    }
    throw error;
  } finally {
    input.destroy();
  }
}

class RewriteHeader extends Transform {
  constructor(originalHeader, nextHeader) {
    super();
    this.originalHeader = originalHeader;
    this.nextHeader = nextHeader;
    this.pending = Buffer.alloc(0);
    this.finishedHeader = false;
  }

  _transform(chunk, encoding, callback) {
    try {
      if (this.finishedHeader) {
        this.push(chunk);
        return callback();
      }
      this.pending = Buffer.concat([this.pending, chunk]);
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) {
        // Provider metadata is capped independently from body sizes.
        if (this.pending.length > 128 * 1024 * 1024) {
          throw new Error("Compressed rollout session metadata exceeds 128 MiB.");
        }
        return callback();
      }
      const before = this.pending.subarray(0, newline + 1);
      const original = Buffer.from(this.originalHeader, "utf8");
      const oldSeparator = before.at(-2) === 0x0d ? "\r\n" : "\n";
      const headerBytes = before.subarray(0, before.length - oldSeparator.length);
      if (!headerBytes.equals(original)) {
        const error = new Error("Compressed rollout header changed before rewrite.");
        error.code = "ROLLOUT_CHANGED";
        throw error;
      }
      this.push(Buffer.from(this.nextHeader + oldSeparator));
      this.push(this.pending.subarray(newline + 1));
      this.pending = null;
      this.finishedHeader = true;
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (!this.finishedHeader) {
        if (!this.pending.equals(Buffer.from(this.originalHeader, "utf8"))) {
          const error = new Error("Compressed rollout header changed before rewrite.");
          error.code = "ROLLOUT_CHANGED";
          throw error;
        }
        this.push(Buffer.from(this.nextHeader, "utf8"));
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

// The compressed payload is re-encoded, while the *uncompressed* body bytes
// after session_meta are copied unmodified. Never emit an uncompressed file.
// Caller revalidates the original snapshot before replacing the source.
export async function stageZstdRolloutHeader(filePath, tmpPath, originalHeader, nextHeader) {
  requireZstd();
  const input = openZstdRollout(filePath);
  try {
    await pipeline(
      input,
      new RewriteHeader(originalHeader, nextHeader),
      zlib.createZstdCompress(),
      fs.createWriteStream(tmpPath, { flags: "wx" })
    );
    const handle = await fsp.open(tmpPath, "r+");
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    input.destroy();
  }
}
