import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, assertText, validateCoverage, validateEntry, validateImportedGroups } from "./schema.mjs";

export const CSV_COLUMNS = [
  "id", "occurredAt", "currency", "instrument", "source",
  "costAmount", "costBasis", "costSource", "costConfidencePercent", "costLow", "costHigh",
  "valueAmount", "valueAssignedBy", "valueMethod",
  "batchSource", "batchCoverageStatus", "batchCoverageFrom", "batchCoverageTo",
];

const REQUIRED_COLUMNS = CSV_COLUMNS.slice(0, 14);
const BATCH_COLUMNS = CSV_COLUMNS.slice(14);

export function parseCsvRows(source) {
  const rows = [];
  let row = [];
  let field = "";
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let quoted = false;
  let afterQuote = false;
  let rowStarted = false;

  const finishField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
    rowStarted = false;
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new TypeError(`CSV import exceeds ${MAX_IMPORT_ROWS} rows`);
  };

  while (index < source.length) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          quoted = false;
          afterQuote = true;
          index += 1;
        }
      } else {
        field += character;
        index += 1;
      }
      continue;
    }
    if (afterQuote && character !== "," && character !== "\n" && character !== "\r") {
      throw new TypeError(`CSV has text after a closing quote at character ${index + 1}`);
    }
    if (character === '"') {
      if (field.length !== 0) throw new TypeError(`CSV quote must begin a field at character ${index + 1}`);
      quoted = true;
      rowStarted = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      finishField();
      rowStarted = true;
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      finishRow();
      if (character === "\r" && source[index + 1] === "\n") index += 2;
      else index += 1;
      continue;
    }
    field += character;
    if (character.trim() !== "") rowStarted = true;
    index += 1;
  }
  if (quoted) throw new TypeError("CSV has an unterminated quoted field");
  if (field.length > 0 || row.length > 0 || rowStarted || afterQuote) finishRow();
  if (rows.length === 0) throw new TypeError("CSV import is empty");
  return rows;
}

function emptyToNull(value) {
  return value === "" ? null : value;
}

function rowEntry(values, index) {
  const id = values.id;
  const costAmount = emptyToNull(values.costAmount);
  const valueAmount = emptyToNull(values.valueAmount);
  let cost = null;
  if (costAmount !== null) {
    const extras = [values.costBasis, values.costSource, values.costConfidencePercent, values.costLow, values.costHigh];
    if (!values.costBasis || !values.costSource) throw new TypeError(`CSV row ${index} has a cost without basis and source`);
    const [low, high] = [emptyToNull(values.costLow), emptyToNull(values.costHigh)];
    if ((low === null) !== (high === null)) throw new TypeError(`CSV row ${index} must provide both costLow and costHigh`);
    const confidenceText = emptyToNull(values.costConfidencePercent);
    cost = {
      amount: costAmount,
      basis: values.costBasis,
      source: values.costSource,
      ...(confidenceText === null ? {} : { confidencePercent: Number(confidenceText) }),
      ...(low === null ? {} : { uncertainty: { low, high } }),
    };
    if (extras.slice(2).some((item) => item !== "") && values.costBasis === "recorded") {
      throw new TypeError(`CSV row ${index} has estimate fields on a recorded cost`);
    }
  } else if ([values.costBasis, values.costSource, values.costConfidencePercent, values.costLow, values.costHigh].some((item) => item !== "")) {
    throw new TypeError(`CSV row ${index} has cost details without a cost amount`);
  }
  let assignedValue = null;
  if (valueAmount !== null) {
    if (!values.valueAssignedBy || !values.valueMethod) throw new TypeError(`CSV row ${index} has a value without assignment provenance`);
    assignedValue = { amount: valueAmount, assignedBy: values.valueAssignedBy, method: values.valueMethod };
  } else if (values.valueAssignedBy !== "" || values.valueMethod !== "") {
    throw new TypeError(`CSV row ${index} has assignment provenance without a value amount`);
  }
  return validateEntry({
    id,
    occurredAt: values.occurredAt,
    currency: values.currency,
    instrument: values.instrument,
    source: values.source,
    cost,
    assignedValue,
  });
}

export function parseCsvImport(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("CSV import must be text");
  if (Buffer.byteLength(source, "utf8") > MAX_IMPORT_BYTES) throw new TypeError(`CSV import exceeds ${MAX_IMPORT_BYTES} bytes`);
  const rows = parseCsvRows(source);
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new TypeError(`CSV import exceeds ${MAX_IMPORT_ROWS} rows`);
  const headers = rows[0];
  const seenHeaders = new Set();
  for (const header of headers) {
    if (seenHeaders.has(header)) throw new TypeError(`CSV has duplicate header ${JSON.stringify(header)}`);
    seenHeaders.add(header);
    if (!CSV_COLUMNS.includes(header)) throw new TypeError(`CSV has unknown column ${JSON.stringify(header)}`);
  }
  for (const header of REQUIRED_COLUMNS) {
    if (!seenHeaders.has(header)) throw new TypeError(`CSV is missing required column ${JSON.stringify(header)}`);
  }
  const hasBatchColumns = BATCH_COLUMNS.some((header) => seenHeaders.has(header));
  if (hasBatchColumns && BATCH_COLUMNS.some((header) => !seenHeaders.has(header))) {
    throw new TypeError("CSV batch metadata requires all four batch columns");
  }
  const columnIndexes = new Map(headers.map((header, columnIndex) => [header, columnIndex]));
  const groups = new Map();
  const ids = new Set();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    if (cells.length !== headers.length) throw new TypeError(`CSV row ${rowIndex + 1} has ${cells.length} cells; expected ${headers.length}`);
    const values = Object.fromEntries(headers.map((header, columnIndex) => [header, cells[columnIndex]]));
    const entry = rowEntry(values, rowIndex + 1);
    if (ids.has(entry.id)) throw new TypeError(`duplicate entry id ${JSON.stringify(entry.id)}`);
    ids.add(entry.id);
    let meta;
    if (hasBatchColumns) {
      const status = values.batchCoverageStatus;
      meta = {
        format: "csv",
        source: assertText(values.batchSource, `CSV row ${rowIndex + 1}.batchSource`, { max: 200 }),
        coverage: validateCoverage({
          status,
          from: emptyToNull(values.batchCoverageFrom),
          to: emptyToNull(values.batchCoverageTo),
        }, `CSV row ${rowIndex + 1}.coverage`),
      };
    } else {
      const optionsBatch = options.batch ?? {};
      meta = {
        format: "csv",
        source: assertText(optionsBatch.source ?? options.source ?? "CSV import", "batch.source", { max: 200 }),
        coverage: validateCoverage(optionsBatch.coverage ?? options.coverage, "batch.coverage"),
      };
    }
    const key = JSON.stringify(meta);
    if (!groups.has(key)) groups.set(key, { ...meta, entries: [] });
    groups.get(key).entries.push(entry);
  }
  return validateImportedGroups([...groups.values()]);
}
