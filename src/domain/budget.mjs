import { addAmounts, formatAmount, parseAmount } from "./money.mjs";
import { assertKeys, assertText, utcMillis, validateWindow } from "./schema.mjs";

const MILLISECONDS_PER_DAY = 86_400_000n;

function signedAmount(value) {
  const amount = BigInt(value);
  return amount < 0n ? `-${formatAmount(-amount)}` : formatAmount(amount);
}

function divideHalfUp(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function formatHundredths(value) {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function sourceCoverage(ledger, window) {
  let completeBatches = 0;
  let partialBatches = 0;
  let unknownBatches = 0;

  for (const batch of ledger.batches) {
    if (batch.coverage.status === "unknown") {
      unknownBatches += 1;
      continue;
    }
    const from = utcMillis(batch.coverage.from);
    const to = utcMillis(batch.coverage.to);
    const overlaps = from < window.toMillis && to > window.fromMillis;
    if (!overlaps) continue;
    if (
      batch.coverage.status === "complete" &&
      from <= window.fromMillis && to >= window.toMillis
    ) completeBatches += 1;
    else partialBatches += 1;
  }

  const status = unknownBatches > 0
    ? "unknown"
    : partialBatches > 0 || completeBatches === 0
      ? "partial"
      : "complete";
  return {
    status,
    completeBatches,
    partialBatches,
    unknownBatches,
    claim: "coverage labels are user-declared and not provider-verified",
  };
}

function validateBudget(value) {
  assertKeys(value, ["amount", "currency", "period", "spendBasis"], ["amount", "currency", "period", "spendBasis"], "budget");
  const amount = assertText(value.amount, "budget.amount", { max: 40 });
  const amountMicros = parseAmount(amount, "budget.amount");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new TypeError("budget.currency must be a three-letter uppercase currency code");
  }
  assertKeys(value.period, ["from", "to"], ["from", "to"], "budget.period");
  const period = validateWindow(value.period.from, value.period.to, "budget.period");
  if (!["recorded", "estimated"].includes(value.spendBasis)) {
    throw new TypeError("budget.spendBasis must be recorded or estimated");
  }
  return {
    amount,
    amountMicros,
    currency: value.currency,
    period: { from: period.from, to: period.to },
    fromMillis: period.fromMillis,
    toMillis: period.toMillis,
    spendBasis: value.spendBasis,
  };
}

export function assessBudget({ assumption, ledger, window, currency, selectedRows }) {
  const coverage = sourceCoverage(ledger, window);
  if (assumption === undefined || assumption === null) {
    return { balance: null, runway: null, status: "unknown-no-budget-or-time-basis-supplied" };
  }

  const budget = validateBudget(assumption);
  const basisRows = selectedRows.filter((entry) => entry.cost?.basis === budget.spendBasis);
  const spendMicros = addAmounts(basisRows.map((entry) => parseAmount(entry.cost.amount)));
  const missingRows = selectedRows.length - basisRows.length;
  const knownSpend = {
    currency,
    amount: formatAmount(spendMicros),
    knownRows: basisRows.length,
    missingRows,
    totalRows: selectedRows.length,
  };
  const alignment = {
    currency: budget.currency === currency ? "aligned" : "mismatch",
    period: budget.fromMillis === window.fromMillis && budget.toMillis === window.toMillis ? "aligned" : "mismatch",
  };

  const reasons = [];
  if (alignment.currency === "mismatch") reasons.push("Budget currency does not match the report currency; balance and runway are unknown.");
  if (alignment.period === "mismatch") reasons.push("Budget period does not exactly match the report interval; balance and runway are unknown.");
  if (coverage.status !== "complete") reasons.push("Source coverage is not complete for the report interval; total spend, balance, and runway are unknown.");
  if (missingRows > 0) reasons.push(`${missingRows} of ${selectedRows.length} selected rows do not have a ${budget.spendBasis} cost; total spend, balance, and runway are unknown.`);

  const common = {
    amount: budget.amount,
    currency: budget.currency,
    period: budget.period,
    spendBasis: budget.spendBasis,
    alignment,
    knownSpend,
    sourceCoverage: coverage,
    runwayIsEstimate: true,
  };
  if (reasons.length > 0) {
    return {
      ...common,
      status: "unknown-assumption-or-coverage-mismatch",
      reason: reasons.join(" "),
      balance: null,
      runwayDays: null,
    };
  }

  const balanceMicros = budget.amountMicros - spendMicros;
  if (spendMicros === 0n) {
    return {
      ...common,
      status: "balance-known-runway-unknown-zero-rate",
      reason: "Balance is known, but the selected basis has zero spend in this interval, so runway is unknown.",
      balance: signedAmount(balanceMicros),
      runwayDays: null,
    };
  }

  const intervalMillis = BigInt(window.toMillis - window.fromMillis);
  const remainingMicros = balanceMicros > 0n ? balanceMicros : 0n;
  const runwayHundredths = divideHalfUp(remainingMicros * intervalMillis * 100n, spendMicros * MILLISECONDS_PER_DAY);
  const status = balanceMicros <= 0n ? "exhausted" : "estimated";
  return {
    ...common,
    status,
    reason: balanceMicros <= 0n
      ? "Budget is exhausted or over budget; estimated remaining runway is zero days."
      : `Runway is an estimate from ${budget.spendBasis} spend over the selected report interval.`,
    balance: signedAmount(balanceMicros),
    runwayDays: formatHundredths(runwayHundredths),
  };
}
