import { parseAmount } from "./money.mjs";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
export const MAX_LEDGER_ENTRIES = 100_000;
export const MAX_LEDGER_BATCHES = 10_000;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

export function assertKeys(value, allowed, required, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${JSON.stringify(key)}`);
  }
}

export function assertText(value, label, { max = 200 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${label} must be non-empty plain text of at most ${max} characters`);
  }
  return value;
}

export function utcMillis(value, label = "timestamp") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a UTC ISO timestamp ending in Z`);
  const match = UTC_PATTERN.exec(value);
  if (!match) throw new TypeError(`${label} must use YYYY-MM-DDTHH:mm:ss[.sss]Z`);
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0") || 0));
  if (
    date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)
  ) throw new TypeError(`${label} is not a real UTC date and time`);
  return date.getTime();
}

export function validateWindow(from, to, label = "window") {
  const fromMillis = utcMillis(from, `${label}.from`);
  const toMillis = utcMillis(to, `${label}.to`);
  if (fromMillis >= toMillis) throw new TypeError(`${label}.from must be earlier than ${label}.to`);
  return { from, to, fromMillis, toMillis };
}

export function validateCoverage(value, label = "coverage") {
  if (value === undefined || value === null) return { status: "unknown", from: null, to: null };
  assertKeys(value, ["status", "from", "to"], ["status"], label);
  const status = value.status;
  if (!["unknown", "partial", "complete"].includes(status)) {
    throw new TypeError(`${label}.status must be unknown, partial, or complete`);
  }
  if (status === "unknown") {
    if ((value.from ?? null) !== null || (value.to ?? null) !== null) {
      throw new TypeError(`${label} with unknown status cannot claim a coverage window`);
    }
    return { status, from: null, to: null };
  }
  const window = validateWindow(value.from, value.to, `${label}.window`);
  return { status, from: window.from, to: window.to };
}

export function validateEntry(value, { allowBatchId = false } = {}) {
  const allowed = ["id", "occurredAt", "currency", "instrument", "source", "cost", "assignedValue"];
  const required = [...allowed];
  if (allowBatchId) allowed.push("batchId");
  assertKeys(value, allowed, required, "entry");
  const id = assertText(value.id, "entry.id", { max: 100 });
  const occurredAt = value.occurredAt;
  utcMillis(occurredAt, `entry ${id}.occurredAt`);
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new TypeError(`entry ${id}.currency must be a three-letter uppercase currency code`);
  }
  const instrument = assertText(value.instrument, `entry ${id}.instrument`, { max: 120 });
  const source = assertText(value.source, `entry ${id}.source`, { max: 200 });
  let cost = null;
  if (value.cost !== null) {
    assertKeys(
      value.cost,
      ["amount", "basis", "source", "confidencePercent", "uncertainty"],
      ["amount", "basis", "source"],
      `entry ${id}.cost`,
    );
    const amount = assertText(value.cost.amount, `entry ${id}.cost.amount`, { max: 40 });
    parseAmount(amount, `entry ${id}.cost.amount`);
    const basis = value.cost.basis;
    if (!["recorded", "estimated"].includes(basis)) throw new TypeError(`entry ${id}.cost.basis must be recorded or estimated`);
    const costSource = assertText(value.cost.source, `entry ${id}.cost.source`, { max: 200 });
    const normalizedCost = { amount, basis, source: costSource };
    let hasUncertainty = false;
    if (Object.hasOwn(value.cost, "confidencePercent")) {
      const confidencePercent = value.cost.confidencePercent;
      if (!Number.isSafeInteger(confidencePercent) || confidencePercent < 0 || confidencePercent > 100) {
        throw new TypeError(`entry ${id}.cost.confidencePercent must be an integer from 0 to 100`);
      }
      normalizedCost.confidencePercent = confidencePercent;
      hasUncertainty = true;
    }
    if (Object.hasOwn(value.cost, "uncertainty")) {
      const uncertainty = value.cost.uncertainty;
      assertKeys(uncertainty, ["low", "high"], ["low", "high"], `entry ${id}.cost.uncertainty`);
      const low = assertText(uncertainty.low, `entry ${id}.cost.uncertainty.low`, { max: 40 });
      const high = assertText(uncertainty.high, `entry ${id}.cost.uncertainty.high`, { max: 40 });
      const lowValue = parseAmount(low, `entry ${id}.cost.uncertainty.low`);
      const highValue = parseAmount(high, `entry ${id}.cost.uncertainty.high`);
      const amountValue = parseAmount(amount, `entry ${id}.cost.amount`);
      if (lowValue > highValue || amountValue < lowValue || amountValue > highValue) {
        throw new TypeError(`entry ${id}.cost.uncertainty must contain its estimate in ascending order`);
      }
      normalizedCost.uncertainty = { low, high };
      hasUncertainty = true;
    }
    if (basis === "estimated" && !hasUncertainty) {
      throw new TypeError(`entry ${id}.estimated cost needs confidencePercent or uncertainty bounds`);
    }
    if (basis === "recorded" && hasUncertainty) {
      throw new TypeError(`entry ${id}.recorded cost cannot include estimate uncertainty`);
    }
    cost = normalizedCost;
  }
  let assignedValue = null;
  if (value.assignedValue !== null) {
    assertKeys(value.assignedValue, ["amount", "assignedBy", "method"], ["amount", "assignedBy", "method"], `entry ${id}.assignedValue`);
    const amount = assertText(value.assignedValue.amount, `entry ${id}.assignedValue.amount`, { max: 40 });
    parseAmount(amount, `entry ${id}.assignedValue.amount`);
    assignedValue = {
      amount,
      assignedBy: assertText(value.assignedValue.assignedBy, `entry ${id}.assignedValue.assignedBy`, { max: 200 }),
      method: assertText(value.assignedValue.method, `entry ${id}.assignedValue.method`, { max: 200 }),
    };
  }
  const entry = { id, occurredAt, currency: value.currency, instrument, source, cost, assignedValue };
  if (allowBatchId) entry.batchId = assertText(value.batchId, `entry ${id}.batchId`, { max: 120 });
  return entry;
}

export function validateBatch(value, { requireId = true } = {}) {
  const allowed = ["id", "importedAt", "format", "source", "coverage"];
  const required = ["format", "source", "coverage"];
  if (requireId) required.push("id", "importedAt");
  assertKeys(value, allowed, required, "batch");
  const batch = {
    format: value.format,
    source: assertText(value.source, "batch.source", { max: 200 }),
    coverage: validateCoverage(value.coverage, "batch.coverage"),
  };
  if (!["csv", "json"].includes(batch.format)) throw new TypeError("batch.format must be csv or json");
  if (requireId) {
    batch.id = assertText(value.id, "batch.id", { max: 120 });
    batch.importedAt = value.importedAt;
    utcMillis(batch.importedAt, `batch ${batch.id}.importedAt`);
  }
  return batch;
}

export function validateImportedGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > MAX_LEDGER_BATCHES) {
    throw new TypeError("import must contain at least one batch and stay within the batch limit");
  }
  let rows = 0;
  const ids = new Set();
  return groups.map((group, groupIndex) => {
    const meta = validateBatch({ format: group.format, source: group.source, coverage: group.coverage }, { requireId: false });
    if (!Array.isArray(group.entries) || group.entries.length === 0) {
      throw new TypeError(`batch ${groupIndex + 1} must contain at least one entry`);
    }
    rows += group.entries.length;
    if (rows > MAX_IMPORT_ROWS) throw new TypeError(`import exceeds ${MAX_IMPORT_ROWS} rows`);
    const entries = group.entries.map((item) => {
      const entry = validateEntry(item);
      if (ids.has(entry.id)) throw new TypeError(`duplicate entry id ${JSON.stringify(entry.id)}`);
      ids.add(entry.id);
      const coverage = meta.coverage;
      if (coverage.status !== "unknown") {
        const time = utcMillis(entry.occurredAt);
        if (time < utcMillis(coverage.from) || time >= utcMillis(coverage.to)) {
          throw new TypeError(`entry ${entry.id} falls outside its batch coverage window`);
        }
      }
      return entry;
    });
    return { ...meta, entries };
  });
}

export function validateLedger(value) {
  assertKeys(value, ["format", "batches", "entries"], ["format", "batches", "entries"], "ledger");
  if (value.format !== "token-roi-ledger/v1") throw new TypeError("ledger.format must be token-roi-ledger/v1");
  if (!Array.isArray(value.batches) || value.batches.length > MAX_LEDGER_BATCHES) {
    throw new TypeError(`ledger.batches must contain at most ${MAX_LEDGER_BATCHES} batches`);
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_LEDGER_ENTRIES) {
    throw new TypeError(`ledger.entries must contain at most ${MAX_LEDGER_ENTRIES} entries`);
  }
  const batches = value.batches.map((batch) => validateBatch(batch));
  const batchIds = new Set();
  const batchById = new Map();
  for (const batch of batches) {
    if (batchIds.has(batch.id)) throw new TypeError(`duplicate batch id ${JSON.stringify(batch.id)}`);
    batchIds.add(batch.id);
    batchById.set(batch.id, batch);
  }
  const entryIds = new Set();
  const entries = value.entries.map((raw) => {
    const entry = validateEntry(raw, { allowBatchId: true });
    if (entryIds.has(entry.id)) throw new TypeError(`duplicate entry id ${JSON.stringify(entry.id)}`);
    entryIds.add(entry.id);
    if (!batchIds.has(entry.batchId)) throw new TypeError(`entry ${entry.id} references an unknown batch`);
    const batch = batchById.get(entry.batchId);
    if (batch.coverage.status !== "unknown") {
      const time = utcMillis(entry.occurredAt);
      if (time < utcMillis(batch.coverage.from) || time >= utcMillis(batch.coverage.to)) {
        throw new TypeError(`entry ${entry.id} falls outside its batch coverage window`);
      }
    }
    return entry;
  });
  return { format: "token-roi-ledger/v1", batches, entries };
}
