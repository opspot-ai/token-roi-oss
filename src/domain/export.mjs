import { CSV_COLUMNS } from "./import-csv.mjs";
import { validateLedger } from "./schema.mjs";

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hasFormulaOrControlPrefix(value) {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC");
  const leading = normalized.match(/^[\p{White_Space}\p{Cc}\p{Cf}\uFEFF]*/u)?.[0] ?? "";
  if (/[\t\r\n]/u.test(leading)) return true;
  return /^[=+\-@]/u.test(normalized.slice(leading.length));
}

function assertCsvSafeRow(row) {
  for (const [column, value] of Object.entries(row)) {
    if (hasFormulaOrControlPrefix(value)) {
      throw new TypeError(`CSV export refused: column ${column} begins with a spreadsheet formula or control prefix. Export as JSON to preserve the exact text.`);
    }
  }
}

export function exportLedgerJson(rawLedger) {
  validateLedger(rawLedger);
  return `${JSON.stringify(rawLedger, null, 2)}\n`;
}

export function exportLedgerCsv(rawLedger) {
  const ledger = validateLedger(rawLedger);
  const batches = new Map(ledger.batches.map((batch) => [batch.id, batch]));
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const entry of ledger.entries) {
    const batch = batches.get(entry.batchId);
    const row = {
      ...entry,
      costAmount: entry.cost?.amount ?? "",
      costBasis: entry.cost?.basis ?? "",
      costSource: entry.cost?.source ?? "",
      costConfidencePercent: entry.cost?.confidencePercent ?? "",
      costLow: entry.cost?.uncertainty?.low ?? "",
      costHigh: entry.cost?.uncertainty?.high ?? "",
      valueAmount: entry.assignedValue?.amount ?? "",
      valueAssignedBy: entry.assignedValue?.assignedBy ?? "",
      valueMethod: entry.assignedValue?.method ?? "",
      batchSource: batch.source,
      batchCoverageStatus: batch.coverage.status,
      batchCoverageFrom: batch.coverage.from ?? "",
      batchCoverageTo: batch.coverage.to ?? "",
    };
    assertCsvSafeRow(row);
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
