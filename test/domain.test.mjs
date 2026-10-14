import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvImport } from "../src/domain/import-csv.mjs";
import { parseJsonImport } from "../src/domain/import-json.mjs";
import { exportLedgerCsv, exportLedgerJson } from "../src/domain/export.mjs";
import { formatAmount, parseAmount, roiPercent } from "../src/domain/money.mjs";
import { parseJsonStrict } from "../src/domain/json-parser.mjs";
import { buildReport } from "../src/domain/report.mjs";
import { validateLedger } from "../src/domain/schema.mjs";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";

function entry(id, options = {}) {
  return {
    id,
    occurredAt: options.occurredAt ?? "2026-10-10T12:00:00Z",
    currency: options.currency ?? "USD",
    instrument: options.instrument ?? "Synthetic work item",
    source: options.source ?? "Synthetic task log",
    cost: options.cost ?? null,
    assignedValue: options.assignedValue ?? null,
    batchId: options.batchId ?? "batch-a",
  };
}

function ledger(entries, batches = [{
  id: "batch-a",
  importedAt: "2026-10-13T09:00:00Z",
  format: "json",
  source: "Synthetic test batch",
  coverage: { status: "unknown", from: null, to: null },
}]) {
  const normalizedEntries = batches.length === 1 && batches[0].id !== "batch-a"
    ? entries.map((item) => item.batchId === "batch-a" ? { ...item, batchId: batches[0].id } : item)
    : entries;
  return validateLedger({ format: "token-roi-ledger/v1", batches, entries: normalizedEntries });
}

test("exact decimal parsing and percentage rounding never use floating point money", () => {
  assert.equal(parseAmount("0.000001"), 1n);
  assert.equal(parseAmount("12.34"), 12_340_000n);
  assert.equal(formatAmount(10n), "0.00001");
  assert.equal(formatAmount(parseAmount("1.230000")), "1.23");
  assert.equal(roiPercent(1n, 3n), "-66.67");
  assert.equal(roiPercent(2n, 3n), "-33.33");
  assert.equal(roiPercent(150n, 100n), "50.00");
  assert.equal(roiPercent(0n, 0n), null);
  assert.throws(() => parseAmount(1.25), /decimal string/);
  assert.throws(() => parseAmount("1.0000001"), /at most six/);
  assert.throws(() => parseAmount("-0.01"), /non-negative/);
});

test("estimated costs require confidence or uncertainty bounds; unknowns stay null", () => {
  const valid = entry("estimated", {
    cost: { amount: "0.50", basis: "estimated", source: "local estimate", confidencePercent: 75 },
  });
  assert.equal(ledger([valid]).entries[0].cost.confidencePercent, 75);
  assert.throws(() => ledger([entry("estimated-bad", {
    cost: { amount: "0.50", basis: "estimated", source: "local estimate" },
  })]), /needs confidencePercent or uncertainty/);
  assert.throws(() => ledger([entry("bounds-bad", {
    cost: { amount: "0.50", basis: "estimated", source: "local estimate", uncertainty: { low: "0.60", high: "0.80" } },
  })]), /must contain its estimate/);
  assert.equal(ledger([entry("unknown")]).entries[0].cost, null);
});

test("reports pair ROI on the same item and preserve recorded and estimated basis coverage", () => {
  const rows = [
    entry("recorded-pair", { cost: { amount: "100", basis: "recorded", source: "invoice" }, assignedValue: { amount: "150", assignedBy: "owner", method: "task value" } }),
    entry("recorded-cost-only", { cost: { amount: "200", basis: "recorded", source: "invoice" } }),
    entry("value-only", { assignedValue: { amount: "1000", assignedBy: "owner", method: "task value" } }),
    entry("estimated-pair", { cost: { amount: "100", basis: "estimated", source: "local estimate", confidencePercent: 60 }, assignedValue: { amount: "90", assignedBy: "owner", method: "task value" } }),
    entry("estimated-cost-only", { cost: { amount: "50", basis: "estimated", source: "local estimate", uncertainty: { low: "40", high: "60" } } }),
    entry("other-currency", { currency: "CAD", cost: { amount: "5", basis: "recorded", source: "invoice" }, assignedValue: { amount: "20", assignedBy: "owner", method: "task value" } }),
    entry("at-exclusive-end", { occurredAt: to, cost: { amount: "9", basis: "recorded", source: "invoice" }, assignedValue: { amount: "19", assignedBy: "owner", method: "task value" } }),
  ];
  const result = buildReport(ledger(rows), { from, to, currency: "USD" });
  assert.equal(result.rowCounts.inWindow, 6);
  assert.equal(result.rowCounts.selectedCurrency, 5);
  assert.equal(result.rowCounts.excludedOtherCurrencies, 1);
  assert.deepEqual(result.rowCounts.excludedByCurrency, { CAD: 1 });
  assert.deepEqual(result.rowIds, ["recorded-pair", "recorded-cost-only", "value-only", "estimated-pair", "estimated-cost-only"]);
  assert.equal(result.costs.recorded.amount, "300");
  assert.equal(result.costs.estimated.amount, "150");
  assert.equal(result.customerAssignedValue.amount, "1240");
  assert.equal(result.roi.scenarios.recorded.matchedCount, 1);
  assert.equal(result.roi.scenarios.recorded.totalRows, 5);
  assert.equal(result.roi.scenarios.recorded.costDenominator, "100");
  assert.equal(result.roi.scenarios.recorded.roiPercent, "50.00");
  assert.equal(result.roi.scenarios.estimated.matchedCount, 1);
  assert.equal(result.roi.scenarios.estimated.costDenominator, "100");
  assert.equal(result.roi.scenarios.estimated.roiPercent, "-10.00");
  assert.deepEqual(result.costs.basisCoverage, {
    recorded: { count: 2, amount: "300" },
    estimated: { count: 2, amount: "150" },
  });
  assert.equal(result.roi.combinedScenario, null);
  assert.equal(result.customerAssignedValue.label, "customer-assigned value; not revenue");
  assert.equal(result.budget.status, "unknown-no-budget-or-time-basis-supplied");
  assert.deepEqual(result.recordSources, [{ source: "Synthetic task log", batchSource: "Synthetic test batch", format: "json", rows: 5 }]);
});

test("recorded-only and estimated-only inputs report their own matched scenarios", () => {
  const recorded = buildReport(ledger([entry("recorded-only", {
    cost: { amount: "2", basis: "recorded", source: "invoice" },
    assignedValue: { amount: "3", assignedBy: "owner", method: "task value" },
  })]), { from, to, currency: "USD" });
  assert.equal(recorded.roi.scenarios.recorded.roiPercent, "50.00");
  assert.equal(recorded.roi.scenarios.estimated.status, "no-matched-items");

  const estimated = buildReport(ledger([entry("estimated-only", {
    cost: { amount: "3", basis: "estimated", source: "estimate", confidencePercent: 50 },
    assignedValue: { amount: "2", assignedBy: "owner", method: "task value" },
  })]), { from, to, currency: "USD" });
  assert.equal(estimated.roi.scenarios.recorded.status, "no-matched-items");
  assert.equal(estimated.roi.scenarios.estimated.roiPercent, "-33.33");
});

test("zero denominators are undefined and coverage stays user-declared", () => {
  const unknownBatch = { id: "batch-a", importedAt: "2026-10-13T09:00:00Z", format: "csv", source: "unmapped import", coverage: { status: "unknown", from: null, to: null } };
  const partialBatch = { id: "batch-b", importedAt: "2026-10-13T09:05:00Z", format: "json", source: "owner-entered work log", coverage: { status: "partial", from, to } };
  const rows = [
    entry("zero", { cost: { amount: "0", basis: "recorded", source: "zero test" }, assignedValue: { amount: "5", assignedBy: "owner", method: "test" } }),
    entry("partial", { batchId: "batch-b", cost: { amount: "2", basis: "estimated", source: "test", confidencePercent: 0 } }),
  ];
  const result = buildReport(ledger(rows, [unknownBatch, partialBatch]), { from, to, currency: "USD" });
  assert.equal(result.roi.scenarios.recorded.status, "undefined-zero-cost-denominator");
  assert.equal(result.roi.scenarios.recorded.roiPercent, null);
  assert.equal(result.costs.unknownRows, 0);
  assert.equal(result.customerAssignedValue.unknownCount, 1);
  assert.equal(result.coverage.unknownBatches, 1);
  assert.equal(result.coverage.partialBatches, 1);
  assert.equal(result.coverage.batches.find((batch) => batch.id === "batch-b").coverageClaim, "user-declared-not-provider-verified");
});

test("budget assumptions require exact valid fields and stay unknown when absent", () => {
  const rows = [entry("recorded", { cost: { amount: "2.50", basis: "recorded", source: "invoice" } })];
  const data = ledger(rows, [{
    id: "complete",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: "Synthetic complete window",
    coverage: { status: "complete", from, to },
  }]);
  const absent = buildReport(data, { from, to, currency: "USD" });
  assert.deepEqual(absent.budget, { balance: null, runway: null, status: "unknown-no-budget-or-time-basis-supplied" });
  assert.throws(() => buildReport(data, { from, to, currency: "USD", budget: { amount: "10" } }), /budget is missing/);
  assert.throws(() => buildReport(data, { from, to, currency: "USD", budget: { amount: "1.0000001", currency: "USD", period: { from, to }, spendBasis: "recorded" } }), /at most six/);
  assert.throws(() => buildReport(data, { from, to, currency: "USD", budget: { amount: "10", currency: "USD", period: { from, to }, spendBasis: "combined" } }), /spendBasis must be recorded or estimated/);
});

test("aligned explicit budget uses exact selected-basis spend and reports an estimated runway", () => {
  const rows = [entry("recorded", { cost: { amount: "20.000001", basis: "recorded", source: "invoice" } })];
  const data = ledger(rows, [{
    id: "complete",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: "Synthetic complete window",
    coverage: { status: "complete", from, to },
  }]);
  const result = buildReport(data, {
    from, to, currency: "USD",
    budget: { amount: "100.000002", currency: "USD", period: { from, to }, spendBasis: "recorded" },
  });
  assert.equal(result.budget.status, "estimated");
  assert.deepEqual(result.budget.alignment, { currency: "aligned", period: "aligned" });
  assert.deepEqual(result.budget.knownSpend, { currency: "USD", amount: "20.000001", knownRows: 1, missingRows: 0, totalRows: 1 });
  assert.equal(result.budget.balance, "80.000001");
  assert.equal(result.budget.runwayDays, "124.00");
  assert.equal(result.budget.runwayIsEstimate, true);
  assert.equal(result.budget.sourceCoverage.status, "complete");
});

test("recorded and estimated budget bases remain separate and incomplete bases cannot imply a total", () => {
  const data = ledger([
    entry("recorded", { cost: { amount: "2", basis: "recorded", source: "invoice" } }),
    entry("estimated", { cost: { amount: "3", basis: "estimated", source: "estimate", confidencePercent: 70 } }),
  ], [{
    id: "complete",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: "Synthetic complete window",
    coverage: { status: "complete", from, to },
  }]);
  const assumptions = (spendBasis) => ({ amount: "10", currency: "USD", period: { from, to }, spendBasis });
  const recorded = buildReport(data, { from, to, currency: "USD", budget: assumptions("recorded") });
  const estimated = buildReport(data, { from, to, currency: "USD", budget: assumptions("estimated") });
  assert.equal(recorded.budget.knownSpend.amount, "2");
  assert.equal(recorded.budget.knownSpend.missingRows, 1);
  assert.equal(recorded.budget.balance, null);
  assert.equal(estimated.budget.knownSpend.amount, "3");
  assert.equal(estimated.budget.knownSpend.missingRows, 1);
  assert.equal(estimated.budget.balance, null);
  assert.equal(recorded.costs.knownAnyBasis.amount, "5");
  assert.equal(recorded.roi.combinedScenario, null);
});

test("budget balance and runway remain unknown for missing, partial, currency, or window coverage", () => {
  const assumption = { amount: "10", currency: "USD", period: { from, to }, spendBasis: "recorded" };
  const completeRows = [entry("recorded", { cost: { amount: "2", basis: "recorded", source: "invoice" } })];
  const completeBatch = [{
    id: "complete",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: "Synthetic complete window",
    coverage: { status: "complete", from, to },
  }];
  const aligned = ledger(completeRows, completeBatch);

  const unknown = buildReport(ledger(completeRows), { from, to, currency: "USD", budget: assumption });
  assert.equal(unknown.budget.sourceCoverage.status, "unknown");
  assert.equal(unknown.budget.balance, null);
  const partial = buildReport(ledger(completeRows, [{
    ...completeBatch[0], coverage: { status: "partial", from, to },
  }]), { from, to, currency: "USD", budget: assumption });
  assert.equal(partial.budget.sourceCoverage.status, "partial");
  assert.equal(partial.budget.balance, null);

  const currencyMismatch = buildReport(aligned, { from, to, currency: "USD", budget: { ...assumption, currency: "CAD" } });
  assert.equal(currencyMismatch.budget.alignment.currency, "mismatch");
  assert.equal(currencyMismatch.budget.balance, null);
  assert.match(currencyMismatch.budget.reason, /currency does not match/);

  const windowMismatch = buildReport(aligned, { from, to, currency: "USD", budget: { ...assumption, period: { from: "2026-10-02T00:00:00Z", to } } });
  assert.equal(windowMismatch.budget.alignment.period, "mismatch");
  assert.equal(windowMismatch.budget.balance, null);
  assert.match(windowMismatch.budget.reason, /period does not exactly match/);
});

test("zero selected-basis rate leaves runway unknown, while exhausted balance stays exact", () => {
  const completeBatch = [{
    id: "complete",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: "Synthetic complete window",
    coverage: { status: "complete", from, to },
  }];
  const assumption = { amount: "10", currency: "USD", period: { from, to }, spendBasis: "recorded" };
  const zero = buildReport(ledger([entry("zero", { cost: { amount: "0", basis: "recorded", source: "zero spend" } })], completeBatch), {
    from, to, currency: "USD", budget: assumption,
  });
  assert.equal(zero.budget.status, "balance-known-runway-unknown-zero-rate");
  assert.equal(zero.budget.balance, "10");
  assert.equal(zero.budget.runwayDays, null);

  const exhausted = buildReport(ledger([entry("spent", { cost: { amount: "12.50", basis: "recorded", source: "invoice" } })], completeBatch), {
    from, to, currency: "USD", budget: assumption,
  });
  assert.equal(exhausted.budget.status, "exhausted");
  assert.equal(exhausted.budget.balance, "-2.5");
  assert.equal(exhausted.budget.runwayDays, "0.00");
});

test("budget assumptions do not change the separate matched ROI scenarios", () => {
  const data = ledger([
    entry("recorded", { cost: { amount: "2", basis: "recorded", source: "invoice" }, assignedValue: { amount: "3", assignedBy: "owner", method: "test" } }),
    entry("estimated", { cost: { amount: "4", basis: "estimated", source: "estimate", confidencePercent: 80 }, assignedValue: { amount: "5", assignedBy: "owner", method: "test" } }),
  ], [{
    id: "complete",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: "Synthetic complete window",
    coverage: { status: "complete", from, to },
  }]);
  const withoutBudget = buildReport(data, { from, to, currency: "USD" });
  const withBudget = buildReport(data, {
    from, to, currency: "USD",
    budget: { amount: "20", currency: "USD", period: { from, to }, spendBasis: "recorded" },
  });
  assert.deepEqual(withBudget.roi, withoutBudget.roi);
  assert.equal(withBudget.budget.knownSpend.amount, "2");
});

test("coverage windows and UTC timestamps are strict and half-open", () => {
  const raw = {
    format: "token-roi-import/v1",
    batch: { source: "bounded batch", coverage: { status: "complete", from, to } },
    entries: [entry("inside", { batchId: undefined })],
  };
  const parsedEntry = { ...raw.entries[0] };
  delete parsedEntry.batchId;
  raw.entries = [parsedEntry];
  const [completeGroup] = parseJsonImport(JSON.stringify(raw));
  assert.equal(completeGroup.entries.length, 1);
  const completeReport = buildReport(ledger([
    { ...completeGroup.entries[0], batchId: "complete-batch" },
  ], [{
    id: "complete-batch",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: completeGroup.source,
    coverage: completeGroup.coverage,
  }]), { from, to, currency: "USD" });
  assert.equal(completeReport.coverage.userDeclaredCompleteBatches, 1);
  assert.equal(completeReport.coverage.batches[0].coverageClaim, "user-declared-not-provider-verified");
  assert.throws(() => parseJsonImport(JSON.stringify({ ...raw, entries: [{ ...parsedEntry, occurredAt: to }] })), /outside its batch coverage window/);
  assert.throws(() => parseJsonImport(JSON.stringify({ ...raw, batch: { source: "bad", coverage: { status: "partial" } } })), /window.from/);
  assert.throws(() => parseJsonImport(JSON.stringify({ ...raw, entries: [{ ...parsedEntry, occurredAt: "2026-02-30T00:00:00Z" }] })), /real UTC date/);
});

test("imports enforce the row bound even when the byte bound is not reached", () => {
  const template = { id: "row", occurredAt: "2026-10-10T00:00:00Z", currency: "USD", instrument: "x", source: "y", cost: null, assignedValue: null };
  const entries = Array.from({ length: 10_001 }, (_, index) => ({ ...template, id: `r${index}` }));
  const raw = JSON.stringify({ format: "token-roi-import/v1", entries });
  assert.ok(Buffer.byteLength(raw) < 2 * 1024 * 1024);
  assert.throws(() => parseJsonImport(raw), /exceeds 10000 rows/);
});

test("JSON rejects duplicate keys, malformed input, duplicate IDs, and unknown fields", () => {
  assert.throws(() => parseJsonStrict('{"name":1,"name":2}'), /Duplicate JSON key/);
  assert.throws(() => parseJsonImport("{broken"), /Expected an object key|Unterminated/);
  const item = { id: "same", occurredAt: "2026-10-10T00:00:00Z", currency: "USD", instrument: "x", source: "y", cost: null, assignedValue: null };
  const raw = JSON.stringify({ format: "token-roi-import/v1", entries: [item, item] });
  assert.throws(() => parseJsonImport(raw), /duplicate entry id/);
  assert.throws(() => parseJsonImport(JSON.stringify({ format: "token-roi-import/v1", entries: [{ ...item, secret: "field" }] })), /unknown field/);
});

test("CSV handles quotes, commas, line breaks, and exported batch provenance", () => {
  const csv = [
    "id,occurredAt,currency,instrument,source,costAmount,costBasis,costSource,costConfidencePercent,costLow,costHigh,valueAmount,valueAssignedBy,valueMethod,batchSource,batchCoverageStatus,batchCoverageFrom,batchCoverageTo",
    'quoted,2026-10-10T13:15:00Z,USD,"Work, item","line one\nline two",0.125,estimated,"local estimate",80,,,1.25,owner,"task, value",batch,partial,2026-10-01T00:00:00Z,2026-11-01T00:00:00Z',
  ].join("\r\n");
  const [group] = parseCsvImport(csv);
  assert.equal(group.entries[0].instrument, "Work, item");
  assert.equal(group.entries[0].source, "line one\nline two");
  assert.equal(group.entries[0].assignedValue.method, "task, value");
  assert.equal(group.source, "batch");
  const roundtrip = parseCsvImport(exportLedgerCsv(ledger([{ ...group.entries[0], batchId: "batch-a" }], [{ id: "batch-a", importedAt: "2026-10-13T09:00:00Z", format: "csv", source: group.source, coverage: group.coverage }])));
  assert.equal(roundtrip[0].entries[0].source, "line one\nline two");
  assert.deepEqual(roundtrip[0].coverage, group.coverage);
});

test("CSV export fails closed on formula/control prefixes and JSON preserves exact text and provenance", () => {
  const prefixes = [
    "=1+1",
    "+SUM(A1:A2)",
    "-1",
    "  +SUM(A1:A2)",
    "\tplain text",
    "\rplain text",
    "\nplain text",
    " @command",
    "＝1+1",
    " ＋SUM(A1:A2)",
    "－1",
    "＠command",
  ];
  for (const [index, instrument] of prefixes.entries()) {
    const data = ledger([entry(`risk-${index}`, { instrument })]);
    assert.throws(() => exportLedgerCsv(data), /Export as JSON to preserve the exact text/);
  }

  const exactText = "  ＝SUM(A1:A2)  ";
  const sourceText = "  =untrusted source  ";
  const data = ledger([entry("json-lossless", { instrument: exactText })], [{
    id: "batch-a",
    importedAt: "2026-10-13T09:00:00Z",
    format: "json",
    source: sourceText,
    coverage: { status: "unknown", from: null, to: null },
  }]);
  const json = exportLedgerJson(data);
  const parsed = JSON.parse(json);
  assert.equal(parsed.entries[0].instrument, exactText);
  assert.equal(parsed.batches[0].source, sourceText);
  const [reimported] = parseJsonImport(json);
  assert.equal(reimported.entries[0].instrument, exactText);
  assert.equal(reimported.source, sourceText);
});

test("CSV rejects malformed quoting, duplicate headers/IDs, and orphan measurements", () => {
  assert.throws(() => parseCsvImport('id,occurredAt,currency,instrument,source,costAmount,costBasis,costSource,costConfidencePercent,costLow,costHigh,valueAmount,valueAssignedBy,valueMethod\n"unfinished'), /unterminated quoted/);
  const header = "id,occurredAt,currency,instrument,source,costAmount,costBasis,costSource,costConfidencePercent,costLow,costHigh,valueAmount,valueAssignedBy,valueMethod";
  assert.throws(() => parseCsvImport(`${header},id\nx,2026-10-10T00:00:00Z,USD,a,b,,,,,,,,,,x`), /duplicate header/);
  const row = "same,2026-10-10T00:00:00Z,USD,a,b,,,,,,,,,";
  assert.throws(() => parseCsvImport(`${header}\n${row}\n${row}`), /duplicate entry id/);
  assert.throws(() => parseCsvImport(`${header}\nx,2026-10-10T00:00:00Z,USD,a,b,,recorded,,,,,,,`), /cost details without a cost amount/);
});
