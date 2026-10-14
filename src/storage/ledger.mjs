import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseJsonStrict } from "../domain/json-parser.mjs";
import {
  MAX_IMPORT_ROWS,
  MAX_LEDGER_BYTES,
  MAX_LEDGER_BATCHES,
  MAX_LEDGER_ENTRIES,
  validateImportedGroups,
  validateLedger,
} from "../domain/schema.mjs";

export function emptyLedger() {
  return { format: "token-roi-ledger/v1", batches: [], entries: [] };
}

export async function readLedger(path) {
  const file = resolve(path);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return emptyLedger();
    throw error;
  }
  if (!info.isFile()) throw new TypeError("ledger path must point to a regular file");
  if (info.size > MAX_LEDGER_BYTES) throw new TypeError(`ledger exceeds ${MAX_LEDGER_BYTES} bytes`);
  const bytes = await readFile(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("ledger is not valid UTF-8 text");
  }
  return validateLedger(parseJsonStrict(text));
}

export async function withLedgerLock(path, operation) {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw Object.assign(new Error("another Token ROI writer holds this ledger lock; retry after it finishes"), { status: 409 });
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export function mergeImportedGroups(rawLedger, rawGroups, { importedAt = new Date().toISOString(), idFactory = randomUUID } = {}) {
  const ledger = validateLedger(rawLedger);
  const groups = validateImportedGroups(rawGroups);
  const knownIds = new Set(ledger.entries.map((entry) => entry.id));
  const incomingCount = groups.reduce((count, group) => count + group.entries.length, 0);
  if (ledger.entries.length + incomingCount > MAX_LEDGER_ENTRIES) {
    throw new TypeError(`ledger would exceed ${MAX_LEDGER_ENTRIES} entries`);
  }
  if (ledger.batches.length + groups.length > MAX_LEDGER_BATCHES) {
    throw new TypeError(`ledger would exceed ${MAX_LEDGER_BATCHES} batches`);
  }
  const batches = [...ledger.batches];
  const entries = [...ledger.entries];
  for (const group of groups) {
    const duplicate = group.entries.find((entry) => knownIds.has(entry.id));
    if (duplicate) throw new TypeError(`entry id ${JSON.stringify(duplicate.id)} already exists; import was not applied`);
    const batchId = `batch_${idFactory()}`;
    batches.push({
      id: batchId,
      importedAt,
      format: group.format,
      source: group.source,
      coverage: group.coverage,
    });
    for (const entry of group.entries) {
      knownIds.add(entry.id);
      entries.push({ ...entry, batchId });
    }
  }
  return validateLedger({ format: "token-roi-ledger/v1", batches, entries });
}

async function ensureParent(path) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
}

export async function writeLedgerAtomic(path, rawLedger) {
  const ledger = validateLedger(rawLedger);
  const file = resolve(path);
  await ensureParent(file);
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return ledger;
}

export async function readTextFileBounded(path, maxBytes) {
  const file = resolve(path);
  const info = await stat(file);
  if (!info.isFile()) throw new TypeError("input path must point to a regular file");
  if (info.size > maxBytes) throw new TypeError(`input exceeds ${maxBytes} bytes`);
  const bytes = await readFile(file);
  if (bytes.byteLength > maxBytes) throw new TypeError(`input exceeds ${maxBytes} bytes`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("input is not valid UTF-8 text");
  }
}

export async function writeOutputExclusive(path, content, { force = false } = {}) {
  const file = resolve(path);
  await ensureParent(file);
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    if (force) await rename(temp, file);
    else {
      const { link } = await import("node:fs/promises");
      await link(temp, file);
      await unlink(temp);
    }
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (error.code === "EEXIST") throw new TypeError(`output already exists: ${file}; pass --force to replace it`);
    throw error;
  }
}

export const STORAGE_LIMITS = { MAX_IMPORT_ROWS, MAX_LEDGER_BYTES, MAX_LEDGER_BATCHES, MAX_LEDGER_ENTRIES };
