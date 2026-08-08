import { copy } from "../copy";

const usdPattern = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/u;

function hasDisallowedModelIdCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (/\s/u.test(character) || code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function usdError(value: string, optional = false): string | undefined {
  const normalized = value.trim();
  if (optional && normalized === "") {
    return undefined;
  }
  if (!usdPattern.test(normalized)) {
    return copy.administration.common.invalidUsd;
  }
  return undefined;
}

export function modelIdError(value: string): string | undefined {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  return normalized.length >= 3 &&
    normalized.length <= 512 &&
    separator > 0 &&
    separator < normalized.length - 1 &&
    !hasDisallowedModelIdCharacter(normalized)
    ? undefined
    : copy.administration.models.invalidModelId;
}

export function positiveIntegerError(value: number): string | undefined {
  return Number.isSafeInteger(value) && value > 0
    ? undefined
    : copy.administration.common.invalidPositiveInteger;
}
