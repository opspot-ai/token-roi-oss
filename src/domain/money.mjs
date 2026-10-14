export const MONEY_SCALE = 1_000_000n;
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,17})(?:\.(\d{1,6}))?$/;

export function parseAmount(value, label = "amount") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a decimal string`);
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) throw new TypeError(`${label} must be a non-negative decimal with at most six fractional digits`);
  const [whole] = value.split(".");
  const fraction = (match[1] ?? "").padEnd(6, "0");
  return BigInt(whole) * MONEY_SCALE + BigInt(fraction || "0");
}

export function formatAmount(micros) {
  const value = BigInt(micros);
  const whole = value / MONEY_SCALE;
  const fraction = (value % MONEY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function addAmounts(values) {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function divideHalfUp(numerator, denominator) {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

export function roiPercent(valueMicros, costMicros) {
  const value = BigInt(valueMicros);
  const cost = BigInt(costMicros);
  if (cost === 0n) return null;
  const hundredths = divideHalfUp((value - cost) * 10_000n, cost);
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
