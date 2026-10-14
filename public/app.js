const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const sessionPromise = fetch("/api/session", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
  if (!response.ok) throw new Error("Local session could not be started.");
  return response.json();
});

const reportForm = document.querySelector("#report-form");
const importForm = document.querySelector("#import-form");
const reportButton = document.querySelector("#report-button");
const importButton = document.querySelector("#import-button");
const reportError = document.querySelector("#report-error");
const exportError = document.querySelector("#export-error");
const importError = document.querySelector("#import-error");
const importMessage = document.querySelector("#import-message");
const emptyState = document.querySelector("#empty-state");
const reportResult = document.querySelector("#report-result");
const ledgerCount = document.querySelector("#ledger-count");
const exportButton = document.querySelector("#export-button");
const exportFormat = document.querySelector("#export-format");
const coverageStatus = document.querySelector("#coverage-status");
const coverageWindow = document.querySelector("#coverage-window");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function currencyAmount(currency, amount, knownCount) {
  return knownCount === 0 ? "Unknown" : `${currency} ${amount}`;
}

function quantity(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function setError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

function clearError(node) {
  node.textContent = "";
  node.hidden = true;
}

function utcDateStart(date) {
  return `${date}T00:00:00Z`;
}

function formatScenario(title, scenario, currency) {
  const section = element("section", "scenario");
  const head = element("div", "scenario-heading");
  head.append(element("h4", "", `${title} cost`));
  const status = scenario.status === "defined" ? "Defined" : scenario.status === "no-matched-items" ? "No matched items" : "Undefined · zero cost denominator";
  const badge = element("span", `status-pill ${scenario.status === "defined" ? "status-good" : "status-unknown"}`);
  badge.append(element("span", "status-dot"), element("span", "", status));
  head.append(badge);
  section.append(head);
  const value = element("p", "scenario-value", scenario.roiPercent === null ? "Undefined" : `${scenario.roiPercent}%`);
  section.append(value);
  section.append(element("p", "scenario-detail", `${quantity(scenario.matchedCount, "matched item")} of ${quantity(scenario.totalRows, "selected row")}`));
  section.append(element("p", "scenario-detail", `Matched denominator: ${currency} ${scenario.costDenominator} · assigned value: ${currency} ${scenario.assignedValue}`));
  return section;
}

function appendSummary(report) {
  const summary = element("div", "summary-grid");
  const cost = element("article", "summary-item");
  cost.append(element("p", "summary-label", "Recorded cost"));
  cost.append(element("p", "summary-value", currencyAmount(report.currency, report.costs.recorded.amount, report.costs.recorded.knownCount)));
  const recordedMissing = report.rowCounts.selectedCurrency - report.costs.recorded.knownCount;
  cost.append(element("p", "summary-detail", `${quantity(report.costs.recorded.knownCount, "known cost row")} · ${quantity(recordedMissing, "row")} without recorded cost`));
  summary.append(cost);

  const estimate = element("article", "summary-item");
  estimate.append(element("p", "summary-label", "Estimated cost"));
  estimate.append(element("p", "summary-value", currencyAmount(report.currency, report.costs.estimated.amount, report.costs.estimated.knownCount)));
  const estimatedMissing = report.rowCounts.selectedCurrency - report.costs.estimated.knownCount;
  estimate.append(element("p", "summary-detail", `${quantity(report.costs.estimated.knownCount, "known cost row")} · ${quantity(estimatedMissing, "row")} without estimated cost`));
  summary.append(estimate);

  const value = element("article", "summary-item");
  value.append(element("p", "summary-label", "Customer-assigned value"));
  value.append(element("p", "summary-value", currencyAmount(report.currency, report.customerAssignedValue.amount, report.customerAssignedValue.knownCount)));
  value.append(element("p", "summary-detail", `${report.customerAssignedValue.knownCount} assigned · ${report.customerAssignedValue.unknownCount} missing · not revenue`));
  summary.append(value);
  return summary;
}

function appendBudget(report) {
  const budget = report.budget;
  const section = element("section", "report-section budget-section");
  const header = element("div", "section-subheading");
  header.append(element("h3", "", "Budget and runway"));
  const label = budget.status === "estimated" ? "Estimated" : budget.status === "exhausted" ? "Exhausted" : "Unknown";
  const badge = element("span", `status-pill ${budget.status === "estimated" ? "status-good" : "status-unknown"}`);
  badge.append(element("span", "status-dot"), element("span", "", label));
  header.append(badge);
  section.append(header);

  if (budget.amount === undefined || budget.amount === null) {
    section.append(element("p", "muted-line", "No explicit budget assumption was supplied."));
    return section;
  }

  const period = budget.period ? `[${budget.period.from}, ${budget.period.to}) UTC` : "period unavailable";
  section.append(element("p", "budget-assumption-line", `${budget.currency} ${budget.amount} · ${budget.spendBasis} spend · ${period}`));
  const summary = element("div", "summary-grid budget-summary");
  const spend = element("article", "summary-item");
  spend.append(element("p", "summary-label", `${budget.spendBasis} spend`));
  spend.append(element("p", "summary-value", currencyAmount(budget.knownSpend.currency, budget.knownSpend.amount, budget.knownSpend.knownRows)));
  spend.append(element("p", "summary-detail", `${quantity(budget.knownSpend.knownRows, "row")} known · ${quantity(budget.knownSpend.missingRows, "row")} missing of ${budget.knownSpend.totalRows}`));
  summary.append(spend);

  const balance = element("article", "summary-item");
  balance.append(element("p", "summary-label", "Budget balance"));
  balance.append(element("p", "summary-value", budget.balance === null ? "Unknown" : `${budget.currency} ${budget.balance}`));
  balance.append(element("p", "summary-detail", "Budget minus supported selected-basis spend"));
  summary.append(balance);

  const runway = element("article", "summary-item");
  runway.append(element("p", "summary-label", "Estimated runway"));
  runway.append(element("p", "summary-value", budget.runwayDays === null ? "Unknown" : `${budget.runwayDays} days`));
  runway.append(element("p", "summary-detail", "Estimated from the selected in-window spend rate"));
  summary.append(runway);
  section.append(summary);

  const source = budget.sourceCoverage;
  section.append(element("p", "budget-coverage-line", `Source coverage: ${source.status} · ${quantity(source.completeBatches, "complete batch", "complete batches")}, ${quantity(source.partialBatches, "partial batch", "partial batches")}, ${quantity(source.unknownBatches, "unknown batch", "unknown batches")}. User-declared, not provider-verified.`));
  section.append(element("p", "plain-limit", budget.reason));
  return section;
}

function appendCoverage(report) {
  const section = element("section", "report-section");
  const header = element("div", "section-subheading");
  header.append(element("h3", "", "Coverage and sources"));
  header.append(element("p", "section-count", `${report.coverage.batches.length} batch${report.coverage.batches.length === 1 ? "" : "es"}`));
  section.append(header);
  if (report.coverage.batches.length === 0) {
    section.append(element("p", "muted-line", "No source batches overlap this window."));
    return section;
  }
  const list = element("ul", "source-list");
  for (const batch of report.coverage.batches) {
    const item = element("li", "source-item");
    const top = element("div", "source-topline");
    top.append(element("strong", "", batch.source));
    const state = batch.coverage.status === "unknown" ? "Unknown coverage" : batch.coverage.status === "partial" ? "Partial · user-declared" : "Complete · user-declared";
    const pill = element("span", "status-pill status-unknown");
    pill.append(element("span", "status-dot"), element("span", "", state));
    top.append(pill);
    item.append(top);
    const range = batch.coverage.from ? ` · [${batch.coverage.from}, ${batch.coverage.to}) UTC` : "";
    item.append(element("p", "source-detail", `${batch.format.toUpperCase()} · ${quantity(batch.rowsInWindow, "row")} in window${range} · not provider-verified`));
    list.append(item);
  }
  section.append(list);
  return section;
}

function appendRows(report, ledger) {
  const selectedIds = new Set(report.rowIds);
  const selected = ledger.entries.filter((entry) => selectedIds.has(entry.id));
  const batches = new Map(ledger.batches.map((batch) => [batch.id, batch]));
  const section = element("section", "report-section");
  const header = element("div", "section-subheading");
  header.append(element("h3", "", "Work items"));
  header.append(element("p", "section-count", quantity(selected.length, "row")));
  section.append(header);
  if (selected.length === 0) {
    section.append(element("p", "muted-line", "No rows match this currency and window."));
    return section;
  }
  const wrapper = element("div", "table-wrap");
  const table = element("table", "ledger-table");
  const caption = element("caption", "visually-hidden", `Work items in ${report.currency} from ${report.window.from} to ${report.window.to}, end excluded`);
  table.append(caption);
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  for (const label of ["Work item", "Timestamp · UTC", "Cost", "Assigned value", "Source"]) {
    headingRow.append(element("th", "", label));
  }
  head.append(headingRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const entry of selected) {
    const batch = batches.get(entry.batchId);
    const row = document.createElement("tr");
    const itemCell = document.createElement("th");
    itemCell.scope = "row";
    itemCell.append(element("strong", "row-title", entry.instrument));
    itemCell.append(element("span", "row-id", entry.id));
    row.append(itemCell);
    row.append(element("td", "mono-cell", entry.occurredAt));
    const cost = entry.cost ? `${report.currency} ${entry.cost.amount} · ${entry.cost.basis}` : "Unknown";
    row.append(element("td", "money-cell", cost));
    const value = entry.assignedValue ? `${report.currency} ${entry.assignedValue.amount}` : "Unknown";
    row.append(element("td", "money-cell", value));
    const sourceCell = document.createElement("td");
    sourceCell.append(element("strong", "row-title", entry.source));
    sourceCell.append(element("span", "source-detail", `Batch: ${batch?.source ?? "unknown"} · ${batch?.format?.toUpperCase() ?? "unknown"}`));
    row.append(sourceCell);
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  section.append(wrapper);
  return section;
}

function renderReport(report, ledger) {
  clear(reportResult);
  reportResult.hidden = false;
  emptyState.hidden = true;
  const titleRow = element("div", "report-title-row");
  const title = element("div", "");
  title.append(element("h3", "report-window-title", `${report.window.from.slice(0, 10)} to ${report.window.to.slice(0, 10)} UTC`));
  title.append(element("p", "report-caption", `${quantity(report.rowCounts.selectedCurrency, `${report.currency} row`)} · ${report.window.interval} interval`));
  titleRow.append(title);
  if (report.rowCounts.excludedOtherCurrencies > 0) {
    titleRow.append(element("p", "excluded-note", `${quantity(report.rowCounts.excludedOtherCurrencies, "other-currency row")} excluded${Object.entries(report.rowCounts.excludedByCurrency).map(([code, count]) => ` · ${code} ${count}`).join("")}`));
  }
  reportResult.append(titleRow);
  reportResult.append(appendSummary(report));

  const roiSection = element("section", "report-section roi-section");
  const roiHead = element("div", "section-subheading");
  roiHead.append(element("h3", "", "Matched-item ROI"));
  roiHead.append(element("p", "section-count", "Separate cost bases"));
  roiSection.append(roiHead);
  roiSection.append(element("p", "formula-note", `${report.roi.formula}. The denominator includes only cost and assigned value paired on the same work item.`));
  const scenarios = element("div", "scenario-grid");
  scenarios.append(formatScenario("Recorded", report.roi.scenarios.recorded, report.currency));
  scenarios.append(formatScenario("Estimated", report.roi.scenarios.estimated, report.currency));
  roiSection.append(scenarios);
  roiSection.append(element("p", "plain-limit", "Matched items only. This ratio is not a measured financial return. Assigned value is not revenue; imports are not provider-verified."));
  reportResult.append(roiSection);
  reportResult.append(appendBudget(report));

  const unknowns = element("section", "report-section unknown-section");
  unknowns.append(element("h3", "", "What is missing"));
  const unknownCosts = report.costs.unknownRows;
  const unknownValues = report.customerAssignedValue.unknownCount;
  unknowns.append(element("p", "", `${quantity(unknownCosts, "row")} ${unknownCosts === 1 ? "has" : "have"} unknown cost and ${quantity(unknownValues, "row")} ${unknownValues === 1 ? "has no" : "have no"} customer-assigned value.`));
  unknowns.append(element("p", "muted-line", "Missing amounts stay unknown. Assigned value is never treated as revenue."));
  reportResult.append(unknowns);
  reportResult.append(appendCoverage(report));
  reportResult.append(appendRows(report, ledger));
}

async function refreshLedgerCount() {
  try {
    const response = await fetch("/api/ledger", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Ledger is unavailable.");
    const ledger = await response.json();
    ledgerCount.textContent = `Ledger: ${quantity(ledger.entries.length, "work item")}`;
    exportButton.disabled = ledger.entries.length === 0;
  } catch {
    ledgerCount.textContent = "Ledger: unavailable";
    exportButton.disabled = true;
  }
}

async function runReport() {
  clearError(reportError);
  reportButton.disabled = true;
  reportButton.textContent = "Loading report…";
  try {
    const from = utcDateStart(document.querySelector("#from-date").value);
    const to = utcDateStart(document.querySelector("#to-date").value);
    const currency = document.querySelector("#currency").value.trim();
    const query = new URLSearchParams({ from, to, currency });
    const budgetFields = [
      ["budgetAmount", document.querySelector("#budget-amount").value],
      ["budgetCurrency", document.querySelector("#budget-currency").value.trim()],
      ["budgetFrom", document.querySelector("#budget-from").value ? utcDateStart(document.querySelector("#budget-from").value) : ""],
      ["budgetTo", document.querySelector("#budget-to").value ? utcDateStart(document.querySelector("#budget-to").value) : ""],
      ["spendBasis", document.querySelector("#spend-basis").value],
    ];
    if (budgetFields.some(([, value]) => value !== "")) {
      for (const [key, value] of budgetFields) if (value !== "") query.set(key, value);
    }
    const [reportResponse, ledgerResponse] = await Promise.all([
      fetch(`/api/report?${query}`, { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/ledger", { cache: "no-store", credentials: "same-origin" }),
    ]);
    const report = await reportResponse.json();
    if (!reportResponse.ok) throw new Error(report.error ?? "Report could not be built.");
    const ledger = await ledgerResponse.json();
    if (!ledgerResponse.ok) throw new Error(ledger.error ?? "Ledger could not be read.");
    renderReport(report, ledger);
  } catch (error) {
    reportResult.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector("h3").textContent = "Report unavailable";
    emptyState.querySelector("p").textContent = "The previous report is hidden. Correct the fields and try again.";
    setError(reportError, error.message);
  } finally {
    reportButton.disabled = false;
    reportButton.textContent = "Run report";
  }
}

reportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runReport();
});

coverageStatus.addEventListener("change", () => {
  const required = coverageStatus.value !== "unknown";
  coverageWindow.hidden = !required;
  document.querySelector("#coverage-from").required = required;
  document.querySelector("#coverage-to").required = required;
});

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError(importError);
  importMessage.textContent = "";
  const file = document.querySelector("#import-file").files[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    setError(importError, `This file is ${file.size.toLocaleString()} bytes. The maximum is ${MAX_IMPORT_BYTES.toLocaleString()} bytes.`);
    return;
  }
  const format = file.name.toLowerCase().endsWith(".csv") ? "csv" : file.name.toLowerCase().endsWith(".json") ? "json" : null;
  if (!format) {
    setError(importError, "Choose a .csv or .json file.");
    return;
  }
  importButton.disabled = true;
  importButton.textContent = "Importing…";
  try {
    const text = await file.text();
    const source = document.querySelector("#batch-source").value.trim();
    const status = coverageStatus.value;
    const coverage = status === "unknown" ? { status } : {
      status,
      from: document.querySelector("#coverage-from").value.trim() || null,
      to: document.querySelector("#coverage-to").value.trim() || null,
    };
    const session = await sessionPromise;
    const response = await fetch("/api/import", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Token-ROI-CSRF": session.csrfToken },
      body: JSON.stringify({ format, text, ...(source ? { source } : {}), coverage }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Import was rejected.");
    importMessage.textContent = `Imported ${quantity(result.importedRows, "row")}. Ledger now has ${result.ledgerRows}.`;
    await refreshLedgerCount();
    await runReport();
  } catch (error) {
    setError(importError, error.message);
  } finally {
    importButton.disabled = false;
    importButton.textContent = "Import batch";
  }
});

exportButton.addEventListener("click", async () => {
  clearError(exportError);
  exportButton.disabled = true;
  exportButton.textContent = "Preparing…";
  try {
    const format = exportFormat.value;
    const response = await fetch(`/api/export?format=${encodeURIComponent(format)}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error ?? "Export could not be prepared.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = `token-roi-ledger.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setError(exportError, error.message);
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = "Export ledger";
  }
});

function setDateDefaults() {
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  document.querySelector("#to-date").value = to.toISOString().slice(0, 10);
  document.querySelector("#from-date").value = from.toISOString().slice(0, 10);
}

setDateDefaults();
refreshLedgerCount();
