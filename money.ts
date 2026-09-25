export type DecimalValue = string | number;

function scaledInteger(value: DecimalValue, scale: number): bigint {
  let source = String(value).trim();
  if (/e/i.test(source)) source = Number(source).toFixed(scale + 6);
  const match = source.match(/^(-?)(\d+)(?:\.(\d*))?$/);
  if (!match) throw new Error(`Valor decimal inválido: ${value}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const kept = (fraction + "0".repeat(scale)).slice(0, scale);
  const roundingDigit = Number(fraction[scale] ?? "0");
  let result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept || "0");
  if (roundingDigit >= 5) result += 1n;
  return result * sign;
}

function roundDivide(numerator: bigint, denominator: bigint) {
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

export function eurosToCents(value: DecimalValue): number {
  return Number(scaledInteger(value, 2));
}

export function centsToEuros(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function calculateVat(subtotalCents: number, rate: DecimalValue): number {
  const scaledRate = scaledInteger(rate, 6);
  return Number(roundDivide(BigInt(subtotalCents) * scaledRate, 1_000_000n));
}

export function calculateLine(input: {
  monthlyFeeCents: number;
  consumedGb: DecimalValue | null;
  includedGb: DecimalValue | null;
  excessGbCents: number | null;
  usageChargesCents: number;
  otherChargesCents: number;
  discountCents: number;
}) {
  const consumed = input.consumedGb == null ? null : scaledInteger(input.consumedGb, 3);
  const included = input.includedGb == null ? null : scaledInteger(input.includedGb, 3);
  const excessMilliGb = consumed != null && included != null && consumed > included ? consumed - included : 0n;
  const excessCharge = input.excessGbCents == null
    ? 0
    : Number(roundDivide(excessMilliGb * BigInt(input.excessGbCents), 1000n));
  const amountCents = input.monthlyFeeCents + excessCharge + input.usageChargesCents +
    input.otherChargesCents - input.discountCents;
  const excessGb = `${excessMilliGb / 1000n}.${String(excessMilliGb % 1000n).padStart(3, "0")}`;
  return { excessGb, excessChargeCents: excessCharge, amountCents };
}

export const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
