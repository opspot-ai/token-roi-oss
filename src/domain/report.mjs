import { addAmounts, formatAmount, parseAmount, roiPercent } from "./money.mjs";
import { assessBudget } from "./budget.mjs";
import { utcMillis, validateLedger, validateWindow } from "./schema.mjs";

function sum(entries, amountOf) {
  return addAmounts(entries.map((entry) => parseAmount(amountOf(entry))));
}

function total(entries, amountOf) {
  const known = entries.filter((entry) => amountOf(entry) !== null);
  return {
    amount: formatAmount(sum(known, amountOf)),
    knownCount: known.length,
    unknownCount: entries.length - known.length,
  };
}

function scenario(entries, basis, totalRows) {
  const matched = entries.filter((entry) => entry.cost?.basis === basis && entry.assignedValue !== null);
  const cost = sum(matched, (entry) => entry.cost.amount);
  const assignedValue = sum(matched, (entry) => entry.assignedValue.amount);
  return {
    basis,
    matchedCount: matched.length,
    totalRows,
    costDenominator: formatAmount(cost),
    assignedValue: formatAmount(assignedValue),
    roiPercent: roiPercent(assignedValue, cost),
    status: matched.length === 0 ? "no-matched-items" : cost === 0n ? "undefined-zero-cost-denominator" : "defined",
  };
}

function batchProvenance(ledger, inWindow) {
  const counts = new Map();
  for (const entry of inWindow) counts.set(entry.batchId, (counts.get(entry.batchId) ?? 0) + 1);
  return ledger.batches
    .filter((batch) => counts.has(batch.id))
    .map((batch) => ({
      id: batch.id,
      format: batch.format,
      source: batch.source,
      coverage: batch.coverage,
      coverageClaim: batch.coverage.status === "unknown" ? "unknown" : "user-declared-not-provider-verified",
      rowsInWindow: counts.get(batch.id),
    }));
}

export function buildReport(rawLedger, { from, to, currency, budget }) {
  const ledger = validateLedger(rawLedger);
  const window = validateWindow(from, to, "report.window");
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("report.currency must be a three-letter uppercase currency code");
  }
  const inWindow = ledger.entries.filter((entry) => {
    const time = utcMillis(entry.occurredAt);
    return time >= window.fromMillis && time < window.toMillis;
  });
  const selected = inWindow.filter((entry) => entry.currency === currency);
  const excludedByCurrency = inWindow.filter((entry) => entry.currency !== currency);
  const recordedCosts = selected.filter((entry) => entry.cost?.basis === "recorded");
  const estimatedCosts = selected.filter((entry) => entry.cost?.basis === "estimated");
  const allCostEntries = selected.filter((entry) => entry.cost !== null);
  const basisCoverage = {
    recorded: { count: recordedCosts.length, amount: formatAmount(sum(recordedCosts, (entry) => entry.cost.amount)) },
    estimated: { count: estimatedCosts.length, amount: formatAmount(sum(estimatedCosts, (entry) => entry.cost.amount)) },
  };
  const provenance = batchProvenance(ledger, inWindow);
  const batchById = new Map(ledger.batches.map((batch) => [batch.id, batch]));
  const sourceCounts = new Map();
  for (const entry of selected) {
    const key = `${entry.batchId}\u0000${entry.source}`;
    const existing = sourceCounts.get(key);
    if (existing) existing.rows += 1;
    else {
      const batch = batchById.get(entry.batchId);
      sourceCounts.set(key, { source: entry.source, batchSource: batch.source, format: batch.format, rows: 1 });
    }
  }
  return {
    format: "token-roi-report/v1",
    window: { from, to, interval: "[from,to)" },
    currency,
    rowCounts: {
      inWindow: inWindow.length,
      selectedCurrency: selected.length,
      excludedOtherCurrencies: excludedByCurrency.length,
      excludedByCurrency: Object.fromEntries(
        [...new Set(excludedByCurrency.map((entry) => entry.currency))]
          .sort()
          .map((code) => [code, excludedByCurrency.filter((entry) => entry.currency === code).length]),
      ),
    },
    rowIds: selected.map((entry) => entry.id),
    costs: {
      recorded: total(recordedCosts, (entry) => entry.cost.amount),
      estimated: total(estimatedCosts, (entry) => entry.cost.amount),
      knownAnyBasis: total(selected, (entry) => entry.cost?.amount ?? null),
      knownCostRows: allCostEntries.length,
      unknownRows: selected.length - allCostEntries.length,
      basisCoverage,
    },
    customerAssignedValue: {
      ...total(selected, (entry) => entry.assignedValue?.amount ?? null),
      label: "customer-assigned value; not revenue",
    },
    roi: {
      formula: "(matched customer-assigned value - matched cost) / matched cost * 100",
      denominator: "sum of costs for same-row pairs with known cost and customer-assigned value",
      scenarios: {
        recorded: scenario(selected, "recorded", selected.length),
        estimated: scenario(selected, "estimated", selected.length),
      },
      combinedScenario: null,
      limitation: "matched items only; not a measured financial return; imported amounts are not provider-verified",
    },
    coverage: {
      batches: provenance,
      unknownBatches: provenance.filter((batch) => batch.coverage.status === "unknown").length,
      partialBatches: provenance.filter((batch) => batch.coverage.status === "partial").length,
      userDeclaredCompleteBatches: provenance.filter((batch) => batch.coverage.status === "complete").length,
      note: "coverage is unknown unless explicitly user-declared; no provider verification is performed",
    },
    recordSources: [...sourceCounts.values()].sort((left, right) => left.source.localeCompare(right.source)),
    budget: assessBudget({ assumption: budget, ledger, window, currency, selectedRows: selected }),
  };
}
