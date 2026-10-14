import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseCsvImport } from "./domain/import-csv.mjs";
import { parseJsonStrict } from "./domain/json-parser.mjs";
import { parseJsonImport } from "./domain/import-json.mjs";
import { exportLedgerCsv, exportLedgerJson } from "./domain/export.mjs";
import { buildReport } from "./domain/report.mjs";
import { MAX_IMPORT_BYTES } from "./domain/schema.mjs";
import { mergeImportedGroups, readLedger, withLedgerLock, writeLedgerAtomic } from "./storage/ledger.mjs";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const STATIC_ROUTES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);
const API_ROUTES = new Set(["/api/session", "/api/ledger", "/api/report", "/api/import", "/api/export"]);
const MAX_REQUEST_BYTES = MAX_IMPORT_BYTES + 32 * 1024;

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function requestPath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("\\")) return null;
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (path.includes("%") || path.includes("..") || path.includes("#")) return null;
  return { path, query: queryIndex < 0 ? "" : rawUrl.slice(queryIndex + 1) };
}

function exactOrigin(origin, port) {
  return origin === `http://127.0.0.1:${port}`;
}

function sameSecret(left, right) {
  if (typeof left !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

async function readBody(request, limit) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw Object.assign(new Error("request body is too large"), { status: 413 });
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.byteLength;
    if (size > limit) throw Object.assign(new Error("request body is too large"), { status: 413 });
    parts.push(part);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw new TypeError("request body is not valid UTF-8 text");
  }
}

function queryValues(queryText, allowedKeys) {
  const params = new URLSearchParams(queryText);
  const result = {};
  for (const key of params.keys()) {
    if (!allowedKeys.includes(key) || Object.hasOwn(result, key)) throw new TypeError(`unexpected or duplicate query parameter ${JSON.stringify(key)}`);
    result[key] = params.get(key);
  }
  return result;
}

export function createLocalServer({ ledgerPath }) {
  if (typeof ledgerPath !== "string" || ledgerPath.trim() === "") throw new TypeError("an explicit ledger path is required");
  const csrfToken = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    securityHeaders(response);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost) {
      sendError(response, 421, "request Host must match the bound loopback address");
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !exactOrigin(origin, port)) {
      sendError(response, 403, "cross-origin request rejected");
      return;
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      sendError(response, 403, "cross-site request rejected");
      return;
    }
    const target = requestPath(request.url);
    if (!target) {
      sendError(response, 404, "route not found");
      return;
    }
    const route = target.path;
    const method = request.method ?? "GET";
    try {
      if (STATIC_ROUTES.has(route) && (method === "GET" || method === "HEAD")) {
        const asset = STATIC_ROUTES.get(route);
        const body = await readFile(fileURLToPath(new URL(asset.file, PUBLIC_DIR)));
        response.writeHead(200, { "Content-Type": asset.type, "Content-Length": body.byteLength });
        response.end(method === "HEAD" ? undefined : body);
        return;
      }
      if (!API_ROUTES.has(route)) {
        sendError(response, 404, "route not found");
        return;
      }
      if (route === "/api/session" && method === "GET") {
        sendJson(response, 200, { csrfToken, maxImportBytes: MAX_IMPORT_BYTES });
        return;
      }
      if (route === "/api/ledger" && method === "GET") {
        sendJson(response, 200, await readLedger(ledgerPath));
        return;
      }
      if (route === "/api/report" && method === "GET") {
        const query = queryValues(target.query, ["from", "to", "currency", "budgetAmount", "budgetCurrency", "budgetFrom", "budgetTo", "spendBasis"]);
        if (!query.from || !query.to || !query.currency) throw new TypeError("report requires from, to, and currency");
        const budgetKeys = ["budgetAmount", "budgetCurrency", "budgetFrom", "budgetTo", "spendBasis"];
        if (budgetKeys.some((key) => Object.hasOwn(query, key))) {
          const assumption = {};
          if (Object.hasOwn(query, "budgetAmount")) assumption.amount = query.budgetAmount;
          if (Object.hasOwn(query, "budgetCurrency")) assumption.currency = query.budgetCurrency;
          if (Object.hasOwn(query, "budgetFrom") || Object.hasOwn(query, "budgetTo")) {
            assumption.period = {};
            if (Object.hasOwn(query, "budgetFrom")) assumption.period.from = query.budgetFrom;
            if (Object.hasOwn(query, "budgetTo")) assumption.period.to = query.budgetTo;
          }
          if (Object.hasOwn(query, "spendBasis")) assumption.spendBasis = query.spendBasis;
          query.budget = assumption;
        }
        sendJson(response, 200, buildReport(await readLedger(ledgerPath), query));
        return;
      }
      if (route === "/api/export" && method === "GET") {
        const query = queryValues(target.query, ["format"]);
        const format = query.format ?? "json";
        if (!["json", "csv"].includes(format)) throw new TypeError("export format must be json or csv");
        const ledger = await readLedger(ledgerPath);
        const body = format === "csv" ? exportLedgerCsv(ledger) : exportLedgerJson(ledger);
        const type = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
        response.writeHead(200, { "Content-Type": type, "Content-Disposition": `attachment; filename=token-roi-ledger.${format}` });
        response.end(body);
        return;
      }
      if (route === "/api/import" && method === "POST") {
        if (!exactOrigin(origin, port)) {
          sendError(response, 403, "state changes require same-origin requests");
          return;
        }
        if (!sameSecret(request.headers["x-token-roi-csrf"], csrfToken)) {
          sendError(response, 403, "missing or invalid CSRF token");
          return;
        }
        if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
          sendError(response, 415, "imports require application/json request bodies");
          return;
        }
        const bodyText = await readBody(request, MAX_REQUEST_BYTES);
        const body = parseJsonStrict(bodyText);
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("import request must be an object");
        const allowed = ["format", "text", "source", "coverage"];
        for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new TypeError(`unexpected import request field ${JSON.stringify(key)}`);
        if (!["csv", "json"].includes(body.format)) throw new TypeError("import format must be csv or json");
        if (typeof body.text !== "string") throw new TypeError("import text must be a string");
        if (Buffer.byteLength(body.text, "utf8") > MAX_IMPORT_BYTES) {
          sendError(response, 413, `import exceeds ${MAX_IMPORT_BYTES} bytes`);
          return;
        }
        const options = { batch: { source: body.source, coverage: body.coverage } };
        const groups = body.format === "csv" ? parseCsvImport(body.text, options) : parseJsonImport(body.text, options);
        const merged = await withLedgerLock(ledgerPath, async () => {
          const next = mergeImportedGroups(await readLedger(ledgerPath), groups);
          await writeLedgerAtomic(ledgerPath, next);
          return next;
        });
        sendJson(response, 201, {
          importedRows: groups.reduce((count, group) => count + group.entries.length, 0),
          importedBatches: groups.length,
          ledgerRows: merged.entries.length,
        });
        return;
      }
      sendError(response, 405, "method not allowed");
    } catch (error) {
      sendError(response, error.status ?? 400, error.message ?? "request failed");
    }
  });
  return server;
}
