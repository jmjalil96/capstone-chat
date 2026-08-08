import { Decimal } from "decimal.js";

const decimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_CEIL });
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/u;

export const USD_SCALE = 18;
export const UNIT_PRICE_SCALE = 24;

export class DecimalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalInputError";
  }
}

function parse(
  value: string,
  label: string,
  maximumIntegerDigits: number,
  maximumFractionDigits: number,
): Decimal {
  const match = decimalPattern.exec(value);
  if (match === null) {
    throw new DecimalInputError(`${label} must be a non-negative plain decimal string`);
  }

  const integerDigits = value.split(".", 1)[0]?.length ?? 0;
  const fractionDigits = match[1]?.length ?? 0;
  if (integerDigits > maximumIntegerDigits || fractionDigits > maximumFractionDigits) {
    throw new DecimalInputError(`${label} exceeds its supported precision`);
  }

  const parsed = new decimal(value);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new DecimalInputError(`${label} must be finite and non-negative`);
  }
  return parsed;
}

function plain(value: Decimal): string {
  const rendered = value.toFixed();
  if (!rendered.includes(".")) {
    return rendered;
  }
  const withoutTrailingZeroes = rendered.replace(/0+$/u, "").replace(/\.$/u, "");
  return withoutTrailingZeroes === "-0" ? "0" : withoutTrailingZeroes;
}

function roundUp(value: Decimal, scale: number): Decimal {
  return value.toDecimalPlaces(scale, Decimal.ROUND_CEIL);
}

export function canonicalUsd(value: string, label = "USD value"): string {
  return plain(parse(value, label, 20, USD_SCALE));
}

export function canonicalUnitPrice(value: string, label = "unit price"): string {
  return plain(parse(value, label, 14, UNIT_PRICE_SCALE));
}

export function unitPricePerMillion(value: string): string {
  return plain(new decimal(canonicalUnitPrice(value)).times(1_000_000));
}

export function canonicalTokenCount(value: unknown, label = "token count"): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new DecimalInputError(`${label} must be a non-negative integer`);
    }
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DecimalInputError(`${label} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }

  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    return BigInt(value);
  }

  throw new DecimalInputError(`${label} must be a non-negative integer`);
}

export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const compared = new decimal(left).comparedTo(new decimal(right));
  return compared < 0 ? -1 : compared > 0 ? 1 : 0;
}

export function maximumDecimal(values: readonly string[], label = "decimal values"): string {
  if (values.length === 0) {
    throw new DecimalInputError(`${label} must contain at least one value`);
  }
  return plain(decimal.max(...values.map((value) => new decimal(value))));
}

export function addUnitPrices(left: string, right: string): string {
  const sum = new decimal(canonicalUnitPrice(left)).plus(canonicalUnitPrice(right));
  return canonicalUnitPrice(plain(roundUp(sum, UNIT_PRICE_SCALE)));
}

export function applyReservationMarginToUnitPrice(
  value: string,
  marginBasisPoints: number,
): string {
  assertMarginBasisPoints(marginBasisPoints);
  const multiplier = new decimal(10_000 + marginBasisPoints).dividedBy(10_000);
  return canonicalUnitPrice(
    plain(roundUp(new decimal(canonicalUnitPrice(value)).times(multiplier), UNIT_PRICE_SCALE)),
  );
}

export function applyReservationMarginToUsd(value: string, marginBasisPoints: number): string {
  assertMarginBasisPoints(marginBasisPoints);
  const multiplier = new decimal(10_000 + marginBasisPoints).dividedBy(10_000);
  return canonicalUsd(
    plain(roundUp(new decimal(canonicalUsd(value)).times(multiplier), USD_SCALE)),
  );
}

export interface ReservationCalculation {
  readonly estimatedInputTokens: bigint;
  readonly maximumOutputTokens: number;
  readonly promptPriceCeilingPerToken: string;
  readonly completionPriceCeilingPerToken: string;
  readonly requestPriceCeilingUsd: string;
}

export function calculateReservationUsd(input: ReservationCalculation): string {
  const estimatedInputTokens = canonicalTokenCount(
    input.estimatedInputTokens,
    "estimated input tokens",
  );
  if (!Number.isSafeInteger(input.maximumOutputTokens) || input.maximumOutputTokens <= 0) {
    throw new DecimalInputError("maximum output tokens must be a positive safe integer");
  }

  const promptCost = new decimal(canonicalUnitPrice(input.promptPriceCeilingPerToken)).times(
    estimatedInputTokens.toString(),
  );
  const completionCost = new decimal(
    canonicalUnitPrice(input.completionPriceCeilingPerToken),
  ).times(input.maximumOutputTokens);
  const requestCost = new decimal(canonicalUsd(input.requestPriceCeilingUsd));
  return canonicalUsd(plain(roundUp(requestCost.plus(promptCost).plus(completionCost), USD_SCALE)));
}

export function addUsd(values: readonly string[]): string {
  const total = values.reduce<Decimal>(
    (sum, value) => sum.plus(canonicalUsd(value)),
    new decimal(0),
  );
  return canonicalUsd(plain(roundUp(total, USD_SCALE)));
}

function assertMarginBasisPoints(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new DecimalInputError("reservation margin must be an integer from 0 to 1000000");
  }
}
