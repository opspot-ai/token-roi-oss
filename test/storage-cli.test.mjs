import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLedger, withLedgerLock } from "../src/storage/ledger.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "bin", "token-roi.mjs");
const demo = join(root, "examples", "demo.json");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("CLI import, report, export, and reload preserve the ledger with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-roi-cli-"));
  const ledgerPath = join(directory, "private", "ledger.json");
  const imported = run(["import", "--ledger", ledgerPath, "--input", demo]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /Imported 4 rows/);
  const ledgerInfo = await stat(ledgerPath);
  assert.equal(ledgerInfo.mode & 0o777, 0o600);
  const firstLedger = await readLedger(ledgerPath);
  assert.equal(firstLedger.entries.length, 4);

  const report = run(["report", "--ledger", ledgerPath, "--from", "2026-10-01T00:00:00Z", "--to", "2026-10-14T00:00:00Z", "--currency", "USD"]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /ROI formula: \(matched customer-assigned value - matched cost\) \/ matched cost \* 100/);
  assert.match(report.stdout, /ROI denominator: sum of costs for same-row pairs/);
  assert.match(report.stdout, /Rows: 3 selected rows; 1 other-currency row excluded/);
  assert.match(report.stdout, /recorded matched-item ROI: 495\.24%/);
  assert.match(report.stdout, /estimated matched-item ROI: 525\.00%/);
  assert.match(report.stdout, /not revenue/);
  assert.match(report.stdout, /not provider-verified/);

  const exportPath = join(directory, "out", "export.json");
  const exported = run(["export", "--ledger", ledgerPath, "--output", exportPath]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
  const beforeDuplicate = await readFile(ledgerPath, "utf8");
  const duplicate = run(["import", "--ledger", ledgerPath, "--input", exportPath]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(await readFile(ledgerPath, "utf8"), beforeDuplicate, "duplicate batch must not change the ledger");

  const replacement = run(["export", "--ledger", ledgerPath, "--output", exportPath]);
  assert.notEqual(replacement.status, 0);
  assert.match(replacement.stderr, /already exists/);
  const forced = run(["export", "--ledger", ledgerPath, "--output", exportPath, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);

  const reloadedPath = join(directory, "reloaded.json");
  const reloaded = run(["import", "--ledger", reloadedPath, "--input", exportPath]);
  assert.equal(reloaded.status, 0, reloaded.stderr);
  const secondLedger = await readLedger(reloadedPath);
  assert.equal(secondLedger.entries.length, 4);
  assert.equal(secondLedger.batches[0].source, "Synthetic local demo");
  assert.deepEqual(secondLedger.entries.map((entry) => entry.id), firstLedger.entries.map((entry) => entry.id));

  const csvPath = join(directory, "export.csv");
  assert.equal(run(["export", "--ledger", ledgerPath, "--output", csvPath]).status, 0);
  const fromCsvPath = join(directory, "csv-reloaded.json");
  const csvReloaded = run(["import", "--ledger", fromCsvPath, "--input", csvPath]);
  assert.equal(csvReloaded.status, 0, csvReloaded.stderr);
  assert.equal((await readLedger(fromCsvPath)).entries.length, 4);
});

test("CLI shares exact budget math and refuses risky CSV while preserving JSON text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-roi-budget-cli-"));
  const ledgerPath = join(directory, "budget-ledger.json");
  const inputPath = join(directory, "complete-window.json");
  await writeFile(inputPath, JSON.stringify({
    format: "token-roi-import/v1",
    batch: {
      source: "Synthetic exact CLI batch",
      coverage: { status: "complete", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    },
    entries: [{
      id: "cli-budget-row",
      occurredAt: "2026-10-10T12:00:00Z",
      currency: "USD",
      instrument: "Synthetic budget task",
      source: "Synthetic complete log",
      cost: { amount: "20.000001", basis: "recorded", source: "Synthetic invoice" },
      assignedValue: null,
    }],
  }));
  const imported = run(["import", "--ledger", ledgerPath, "--input", inputPath]);
  assert.equal(imported.status, 0, imported.stderr);
  const assumption = [
    "--budget", "100.000002",
    "--budget-currency", "USD",
    "--budget-from", "2026-10-01T00:00:00Z",
    "--budget-to", "2026-11-01T00:00:00Z",
    "--spend-basis", "recorded",
  ];
  const report = run(["report", "--ledger", ledgerPath, "--from", "2026-10-01T00:00:00Z", "--to", "2026-11-01T00:00:00Z", "--currency", "USD", ...assumption]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Budget balance: USD 80\.000001/);
  assert.match(report.stdout, /Estimated runway: 124\.00 days/);
  assert.match(report.stdout, /Recorded basis coverage: 1 known cost row · 0 selected rows without recorded cost/);
  assert.match(report.stdout, /Estimated basis coverage: 0 known cost rows · 1 selected row without estimated cost/);
  assert.match(report.stdout, /Source coverage for budget: complete/);
  assert.match(report.stdout, /1 row in window/);
  assert.match(report.stdout, /0 matched items of 1 selected row/);
  assert.match(report.stdout, /1 user-declared complete batch\b/);

  const incompleteAssumption = run(["report", "--ledger", ledgerPath, "--from", "2026-10-01T00:00:00Z", "--to", "2026-11-01T00:00:00Z", "--currency", "USD", "--budget", "100"]);
  assert.notEqual(incompleteAssumption.status, 0);
  assert.match(incompleteAssumption.stderr, /budget assumptions require all/);

  const riskyLedgerPath = join(directory, "risky-ledger.json");
  const riskyInputPath = join(directory, "risky-input.json");
  const exactText = "  ＝SUM(A1:A2)  ";
  await writeFile(riskyInputPath, JSON.stringify({
    format: "token-roi-import/v1",
    entries: [{
      id: "risky-text",
      occurredAt: "2026-10-10T12:00:00Z",
      currency: "USD",
      instrument: exactText,
      source: "Synthetic untrusted text",
      cost: null,
      assignedValue: null,
    }],
  }));
  assert.equal(run(["import", "--ledger", riskyLedgerPath, "--input", riskyInputPath]).status, 0);
  const csv = run(["export", "--ledger", riskyLedgerPath, "--output", join(directory, "risky.csv")]);
  assert.notEqual(csv.status, 0);
  assert.match(csv.stderr, /Export as JSON to preserve the exact text/);
  const jsonPath = join(directory, "lossless.json");
  const json = run(["export", "--ledger", riskyLedgerPath, "--output", jsonPath]);
  assert.equal(json.status, 0, json.stderr);
  const reloadedPath = join(directory, "lossless-reloaded.json");
  const reloaded = run(["import", "--ledger", reloadedPath, "--input", jsonPath]);
  assert.equal(reloaded.status, 0, reloaded.stderr);
  assert.equal((await readLedger(reloadedPath)).entries[0].instrument, exactText);
});

test("CLI requires explicit paths and rejects oversized inputs before parsing", async () => {
  const missingLedger = run(["report", "--from", "2026-10-01T00:00:00Z", "--to", "2026-11-01T00:00:00Z", "--currency", "USD"]);
  assert.notEqual(missingLedger.status, 0);
  assert.match(missingLedger.stderr, /--ledger is required/);

  const directory = await mkdtemp(join(tmpdir(), "token-roi-size-"));
  const input = join(directory, "oversized.json");
  await writeFile(input, " ".repeat(2 * 1024 * 1024 + 1));
  const oversized = run(["import", "--ledger", join(directory, "ledger.json"), "--input", input]);
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /exceeds 2097152 bytes/);
});

test("ledger lock prevents overlapping writers and releases after failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-roi-lock-"));
  const ledgerPath = join(directory, "ledger.json");
  let announceStart;
  let releaseFirst;
  const started = new Promise((resolve) => { announceStart = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withLedgerLock(ledgerPath, async () => {
    announceStart();
    await release;
    throw new Error("synthetic writer failure");
  });
  await started;
  await assert.rejects(withLedgerLock(ledgerPath, async () => "overlapped"), /another Token ROI writer holds this ledger lock/);
  releaseFirst();
  await assert.rejects(first, /synthetic writer failure/);
  const afterFailure = await withLedgerLock(ledgerPath, async () => "released");
  assert.equal(afterFailure, "released");
  assert.equal(await stat(`${ledgerPath}.lock`).then(() => true, () => false), false);
});
