#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseCsvImport } from "../src/domain/import-csv.mjs";
import { parseJsonImport } from "../src/domain/import-json.mjs";
import { exportLedgerCsv, exportLedgerJson } from "../src/domain/export.mjs";
import { buildReport } from "../src/domain/report.mjs";
import { MAX_IMPORT_BYTES } from "../src/domain/schema.mjs";
import {
  mergeImportedGroups,
  readLedger,
  readTextFileBounded,
  withLedgerLock,
  writeLedgerAtomic,
  writeOutputExclusive,
} from "../src/storage/ledger.mjs";

const HELP = `Token ROI — local meter for attributable AI work

Commands:
  token-roi import --ledger PATH --input PATH [--format csv|json] [--source TEXT]
                   [--coverage unknown|partial|complete --from UTC --to UTC]
  token-roi report --ledger PATH --from UTC --to UTC --currency USD
                   [--budget DECIMAL --budget-currency USD --budget-from UTC --budget-to UTC]
                   [--spend-basis recorded|estimated]
  token-roi export --ledger PATH --output PATH [--format json|csv] [--force]
  token-roi serve  --ledger PATH [--host 127.0.0.1] [--port 4173]

All ledger and output paths are explicit. Imports merge new IDs and fail atomically
on duplicates. Exports refuse to replace files unless --force is supplied.
`;

function parseFlags(args, booleanFlags = []) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new TypeError(`unexpected argument ${JSON.stringify(argument)}`);
    const key = argument.slice(2);
    if (!key || Object.hasOwn(result, key)) throw new TypeError(`duplicate or empty flag ${argument}`);
    if (booleanFlags.includes(key)) result[key] = true;
    else {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${argument} needs a value`);
      result[key] = value;
      index += 1;
    }
  }
  const allowed = new Set(["ledger", "input", "format", "source", "coverage", "from", "to", "currency", "output", "force", "host", "port", "budget", "budget-currency", "budget-from", "budget-to", "spend-basis"]);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new TypeError(`unknown flag --${key}`);
  return result;
}

function required(flags, name) {
  if (!flags[name]) throw new TypeError(`--${name} is required`);
  return flags[name];
}

function quantity(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function batchOptions(flags) {
  const status = flags.coverage ?? "unknown";
  return {
    source: flags.source,
    coverage: { status, from: flags.from ?? null, to: flags.to ?? null },
  };
}

function budgetOptions(flags) {
  const names = ["budget", "budget-currency", "budget-from", "budget-to", "spend-basis"];
  if (!names.some((name) => Object.hasOwn(flags, name))) return undefined;
  const missing = names.filter((name) => !Object.hasOwn(flags, name));
  if (missing.length > 0) {
    throw new TypeError(`budget assumptions require all of ${names.map((name) => `--${name}`).join(", ")}`);
  }
  return {
    amount: flags.budget,
    currency: flags["budget-currency"],
    period: { from: flags["budget-from"], to: flags["budget-to"] },
    spendBasis: flags["spend-basis"],
  };
}

function inferFormat(path, explicit) {
  if (explicit === "csv" || explicit === "json") return explicit;
  if (explicit) throw new TypeError("--format must be csv or json");
  if (/\.csv$/i.test(path)) return "csv";
  if (/\.json$/i.test(path)) return "json";
  throw new TypeError("cannot infer input format; pass --format csv or json");
}

function printReport(report) {
  console.log(`Window [${report.window.from}, ${report.window.to}) · ${report.currency}`);
  console.log(`Rows: ${quantity(report.rowCounts.selectedCurrency, "selected row")}; ${quantity(report.rowCounts.excludedOtherCurrencies, "other-currency row")} excluded`);
  for (const [currency, count] of Object.entries(report.rowCounts.excludedByCurrency)) console.log(`  ${currency}: ${count} excluded`);
  console.log(`ROI formula: ${report.roi.formula}`);
  console.log(`ROI denominator: ${report.roi.denominator}`);
  console.log(`Recorded cost subtotal: ${report.costs.recorded.knownCount ? report.currency + " " + report.costs.recorded.amount : "unknown"} (${quantity(report.costs.recorded.knownCount, "row")})`);
  console.log(`Recorded basis coverage: ${quantity(report.costs.recorded.knownCount, "known cost row")} · ${quantity(report.rowCounts.selectedCurrency - report.costs.recorded.knownCount, "selected row")} without recorded cost`);
  console.log(`Estimated cost subtotal: ${report.costs.estimated.knownCount ? report.currency + " " + report.costs.estimated.amount : "unknown"} (${quantity(report.costs.estimated.knownCount, "row")})`);
  console.log(`Estimated basis coverage: ${quantity(report.costs.estimated.knownCount, "known cost row")} · ${quantity(report.rowCounts.selectedCurrency - report.costs.estimated.knownCount, "selected row")} without estimated cost`);
  console.log(`Customer-assigned value: ${report.customerAssignedValue.knownCount ? report.currency + " " + report.customerAssignedValue.amount : "unknown"} (${quantity(report.customerAssignedValue.knownCount, "row")}; not revenue)`);
  for (const basis of ["recorded", "estimated"]) {
    const scenario = report.roi.scenarios[basis];
    const value = scenario.roiPercent === null ? "undefined" : `${scenario.roiPercent}%`;
    console.log(`${basis} matched-item ROI: ${value} (${quantity(scenario.matchedCount, "matched item")} of ${quantity(scenario.totalRows, "selected row")}; denominator ${report.currency} ${scenario.costDenominator})`);
  }
  console.log("Matched-item ROI is not a measured financial return.");
  console.log(`Coverage: ${quantity(report.coverage.unknownBatches, "unknown-coverage batch", "unknown-coverage batches")}, ${quantity(report.coverage.partialBatches, "partial-coverage batch", "partial-coverage batches")}, ${quantity(report.coverage.userDeclaredCompleteBatches, "user-declared complete batch", "user-declared complete batches")}`);
  const budget = report.budget;
  if (budget.amount === undefined || budget.amount === null) {
    console.log("Budget balance and runway are unknown because no explicit budget assumption was supplied.");
  } else {
    const knownSpend = `${budget.knownSpend.currency} ${budget.knownSpend.amount} (${quantity(budget.knownSpend.knownRows, "row")} known; ${quantity(budget.knownSpend.missingRows, "row")} missing for ${budget.spendBasis} basis)`;
    console.log(`Budget basis: ${budget.spendBasis} · ${knownSpend}`);
    console.log(`Source coverage for budget: ${budget.sourceCoverage.status} (${quantity(budget.sourceCoverage.completeBatches, "complete batch", "complete batches")}, ${quantity(budget.sourceCoverage.partialBatches, "partial batch", "partial batches")}, ${quantity(budget.sourceCoverage.unknownBatches, "unknown batch", "unknown batches")}; user-declared, not provider-verified)`);
    console.log(`Budget balance: ${budget.balance === null ? "unknown" : `${budget.currency} ${budget.balance}`}`);
    console.log(`Estimated runway: ${budget.runwayDays === null ? "unknown" : `${budget.runwayDays} days`} · ${budget.reason}`);
  }
  console.log("Assigned value is not revenue. Imported amounts are not provider-verified.");
  if (report.coverage.batches.length) {
    console.log("Sources:");
    for (const batch of report.coverage.batches) {
      const window = batch.coverage.from ? ` [${batch.coverage.from}, ${batch.coverage.to})` : "";
      console.log(`  ${batch.format} · ${batch.source} · ${batch.coverage.status}${window} · ${quantity(batch.rowsInWindow, "row")} in window`);
    }
  }
  if (report.recordSources.length) {
    console.log("Record sources:");
    for (const source of report.recordSources) console.log(`  ${source.source} · ${quantity(source.rows, "row")} · batch ${source.format}: ${source.batchSource}`);
  }
}

export async function runCLI(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "import") {
    const flags = parseFlags(rest);
    const ledgerPath = required(flags, "ledger");
    const inputPath = required(flags, "input");
    const format = inferFormat(inputPath, flags.format);
    const text = await readTextFileBounded(inputPath, MAX_IMPORT_BYTES);
    const groups = format === "csv" ? parseCsvImport(text, { batch: batchOptions(flags) }) : parseJsonImport(text, { batch: batchOptions(flags) });
    const merged = await withLedgerLock(ledgerPath, async () => {
      const ledger = await readLedger(ledgerPath);
      const next = mergeImportedGroups(ledger, groups);
      await writeLedgerAtomic(ledgerPath, next);
      return next;
    });
    console.log(`Imported ${quantity(groups.reduce((count, group) => count + group.entries.length, 0), "row")} in ${quantity(groups.length, "batch", "batches")}. Ledger has ${quantity(merged.entries.length, "row")}.`);
    return;
  }
  if (command === "report") {
    const flags = parseFlags(rest);
    const ledger = await readLedger(required(flags, "ledger"));
    const report = buildReport(ledger, {
      from: required(flags, "from"),
      to: required(flags, "to"),
      currency: required(flags, "currency"),
      budget: budgetOptions(flags),
    });
    printReport(report);
    return;
  }
  if (command === "export") {
    const flags = parseFlags(rest, ["force"]);
    const ledger = await readLedger(required(flags, "ledger"));
    const output = required(flags, "output");
    const format = inferFormat(output, flags.format);
    const content = format === "csv" ? exportLedgerCsv(ledger) : exportLedgerJson(ledger);
    await writeOutputExclusive(output, content, { force: flags.force === true });
    console.log(`Exported ${quantity(ledger.entries.length, "row")} as ${format} to ${output}`);
    return;
  }
  if (command === "serve") {
    const flags = parseFlags(rest);
    const ledgerPath = required(flags, "ledger");
    const host = flags.host ?? "127.0.0.1";
    if (host !== "127.0.0.1") throw new TypeError("server host must be 127.0.0.1");
    const port = flags.port === undefined ? 4173 : Number(flags.port);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("--port must be an integer from 0 to 65535");
    const { createLocalServer } = await import("../src/server.mjs");
    const server = createLocalServer({ ledgerPath });
    server.listen(port, host, () => {
      const address = server.address();
      console.log(`Token ROI is listening at http://127.0.0.1:${address.port}/`);
      console.log(`Ledger: ${ledgerPath}`);
    });
    server.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    return;
  }
  throw new TypeError(`unknown command ${JSON.stringify(command)}\n\n${HELP}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCLI().catch((error) => {
    console.error(`token-roi: ${error.message}`);
    process.exitCode = 1;
  });
}
