import { parseJsonStrict } from "./json-parser.mjs";
import {
  MAX_IMPORT_BYTES,
  assertKeys,
  assertText,
  validateBatch,
  validateCoverage,
  validateEntry,
  validateImportedGroups,
  validateLedger,
} from "./schema.mjs";

function defaultBatch(options = {}) {
  const input = options.batch ?? {};
  assertKeys(input, ["source", "coverage"], [], "import batch metadata");
  return {
    format: "json",
    source: assertText(input.source ?? options.source ?? "JSON import", "batch.source", { max: 200 }),
    coverage: validateCoverage(input.coverage ?? options.coverage, "batch.coverage"),
  };
}

function entryWithoutBatchId(entry) {
  const { batchId: _batchId, ...rest } = entry;
  return rest;
}

export function parseJsonImport(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("JSON import must be text");
  if (Buffer.byteLength(source, "utf8") > MAX_IMPORT_BYTES) throw new TypeError(`JSON import exceeds ${MAX_IMPORT_BYTES} bytes`);
  const data = parseJsonStrict(source);
  let groups;
  if (data?.format === "token-roi-ledger/v1") {
    const ledger = validateLedger(data);
    groups = ledger.batches.map((batch) => ({
      ...batch,
      entries: ledger.entries.filter((entry) => entry.batchId === batch.id).map(entryWithoutBatchId),
    }));
    if (groups.some((group) => group.entries.length === 0)) throw new TypeError("ledger import contains a batch without entries");
  } else if (Array.isArray(data)) {
    const meta = defaultBatch(options);
    groups = [{ ...meta, entries: data.map((entry) => validateEntry(entry)) }];
  } else {
    assertKeys(data, ["format", "batch", "entries"], ["format", "entries"], "JSON import");
    if (data.format !== "token-roi-import/v1") throw new TypeError("JSON import.format must be token-roi-import/v1");
    let meta = defaultBatch(options);
    if (Object.hasOwn(data, "batch")) {
      assertKeys(data.batch, ["source", "coverage"], [], "JSON import.batch");
      meta = {
        format: "json",
        source: assertText(data.batch.source ?? meta.source, "batch.source", { max: 200 }),
        coverage: validateCoverage(data.batch.coverage ?? meta.coverage, "batch.coverage"),
      };
    }
    if (!Array.isArray(data.entries)) throw new TypeError("JSON import.entries must be an array");
    groups = [{ ...meta, entries: data.entries.map((entry) => validateEntry(entry)) }];
  }
  return validateImportedGroups(groups);
}
