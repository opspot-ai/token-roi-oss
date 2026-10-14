import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalServer } from "../src/server.mjs";
import { MAX_IMPORT_BYTES } from "../src/domain/schema.mjs";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const sample = JSON.stringify({
  format: "token-roi-import/v1",
  batch: { source: "Browser synthetic", coverage: { status: "partial", from, to } },
  entries: [{
    id: "browser-pair",
    occurredAt: "2026-10-10T12:00:00Z",
    currency: "USD",
    instrument: "Browser demo task",
    source: "Synthetic browser test",
    cost: { amount: "0.25", basis: "recorded", source: "Synthetic cost" },
    assignedValue: { amount: "1.00", assignedBy: "Test owner", method: "Synthetic value" },
  }],
});

async function rawRequest(port, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Host: `127.0.0.1:${port}`, ...headers },
    body,
  });
  return response;
}

function requestWithHost(port, path, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

test("local HTTP boundaries reject hostile hosts, origins, CSRF, traversal, and oversized imports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-roi-http-"));
  const ledgerPath = join(directory, "ledger.json");
  const server = createLocalServer({ ledgerPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const home = await rawRequest(port, "/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(await home.text(), /A clearer view of AI work/);

  const hostileHost = await requestWithHost(port, "/api/ledger", "attacker.invalid");
  assert.equal(hostileHost, 421);
  const traversal = await rawRequest(port, "/%2e%2e/fixture-file");
  assert.equal(traversal.status, 404);
  const arbitraryFile = await rawRequest(port, "/fixture-file-route-test-only");
  assert.equal(arbitraryFile.status, 404);
  const externalOriginGet = await rawRequest(port, "/api/session", { headers: { Origin: "https://attacker.invalid" } });
  assert.equal(externalOriginGet.status, 403);

  const session = await rawRequest(port, "/api/session");
  const { csrfToken } = await session.json();
  const badOrigin = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: sample }),
  });
  assert.equal(badOrigin.status, 403);
  const missingCsrf = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ format: "json", text: sample }),
  });
  assert.equal(missingCsrf.status, 403);
  const missingOrigin = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: sample }),
  });
  assert.equal(missingOrigin.status, 403);

  const oversizeText = "x".repeat(MAX_IMPORT_BYTES + 1);
  const oversized = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: oversizeText }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(await stat(ledgerPath).then(() => true, () => false), false, "rejected requests must not create or alter the ledger");
});

test("local HTTP import, report, export, path isolation, and markup remain safe", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-roi-http-journey-"));
  const ledgerPath = join(directory, "ledger.json");
  const server = createLocalServer({ ledgerPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const session = await rawRequest(port, "/api/session");
  const { csrfToken } = await session.json();
  const good = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: sample }),
  });
  assert.equal(good.status, 201);
  assert.equal((await good.json()).ledgerRows, 1);
  const report = await rawRequest(port, `/api/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&currency=USD`);
  assert.equal(report.status, 200);
  const reportBody = await report.json();
  assert.equal(reportBody.roi.scenarios.recorded.roiPercent, "300.00");
  assert.deepEqual(reportBody.budget, { balance: null, runway: null, status: "unknown-no-budget-or-time-basis-supplied" });
  const exported = await rawRequest(port, "/api/export?format=json");
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /token-roi-ledger\.json/);
  assert.equal(JSON.parse(await exported.text()).entries.length, 1);

  const markup = JSON.stringify({
    format: "token-roi-import/v1",
    entries: [{
      id: "markup-row",
      occurredAt: "2026-10-10T13:00:00Z",
      currency: "USD",
      instrument: "<img src=x onerror=alert(1)>",
      source: "untrusted text",
      cost: null,
      assignedValue: null,
    }],
  });
  const markupResult = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: markup }),
  });
  assert.equal(markupResult.status, 201);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.entries[1].instrument, "<img src=x onerror=alert(1)>");

  const unknownRoute = await rawRequest(port, "/api/../fixture-file");
  assert.equal(unknownRoute.status, 404);
  const runtimeFiles = ["../public/index.html", "../public/app.js", "../public/styles.css"];
  const runtime = (await Promise.all(runtimeFiles.map((path) => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(runtime, /https?:\/\/(?!127\.0\.0\.1)/i);
  assert.doesNotMatch(runtime, /api\.openai|anthropic\.com|segment\.io|https?:\/\/(?!127\.0\.0\.1)/i);
});

test("local report API shares explicit budget assumptions and CSV risk returns a JSON fallback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "token-roi-http-budget-"));
  const ledgerPath = join(directory, "ledger.json");
  const server = createLocalServer({ ledgerPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const session = await rawRequest(port, "/api/session");
  const { csrfToken } = await session.json();
  const completeInput = JSON.stringify({
    format: "token-roi-import/v1",
    batch: { source: "Synthetic complete HTTP batch", coverage: { status: "complete", from, to } },
    entries: [{
      id: "http-budget-row",
      occurredAt: "2026-10-10T12:00:00Z",
      currency: "USD",
      instrument: "Synthetic HTTP budget task",
      source: "Synthetic complete log",
      cost: { amount: "20.000001", basis: "recorded", source: "Synthetic invoice" },
      assignedValue: null,
    }],
  });
  const imported = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: completeInput }),
  });
  assert.equal(imported.status, 201);

  const query = new URLSearchParams({
    from, to, currency: "USD",
    budgetAmount: "100.000002",
    budgetCurrency: "USD",
    budgetFrom: from,
    budgetTo: to,
    spendBasis: "recorded",
  });
  const report = await rawRequest(port, `/api/report?${query}`);
  assert.equal(report.status, 200);
  const result = await report.json();
  assert.equal(result.budget.balance, "80.000001");
  assert.equal(result.budget.runwayDays, "124.00");

  const partialAssumption = new URLSearchParams({ from, to, currency: "USD", budgetAmount: "100" });
  const invalid = await rawRequest(port, `/api/report?${partialAssumption}`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /budget is missing/);

  const risky = JSON.stringify({
    format: "token-roi-import/v1",
    entries: [{
      id: "http-risky-text",
      occurredAt: "2026-10-10T13:00:00Z",
      currency: "USD",
      instrument: "  =SUM(A1:A2)",
      source: "Synthetic risk fixture",
      cost: null,
      assignedValue: null,
    }],
  });
  const riskyImport = await rawRequest(port, "/api/import", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Token-ROI-CSRF": csrfToken },
    body: JSON.stringify({ format: "json", text: risky }),
  });
  assert.equal(riskyImport.status, 201);
  const csv = await rawRequest(port, "/api/export?format=csv");
  assert.equal(csv.status, 400);
  assert.match((await csv.json()).error, /Export as JSON to preserve the exact text/);
  const json = await rawRequest(port, "/api/export?format=json");
  assert.equal(json.status, 200);
  const exported = await json.json();
  assert.equal(exported.entries.find((entry) => entry.id === "http-risky-text").instrument, "  =SUM(A1:A2)");
});
