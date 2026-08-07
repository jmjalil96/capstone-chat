import { copy } from "../copy";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function requiredError(value: string): string | undefined {
  return value.trim() ? undefined : copy.identity.common.required;
}

export function emailError(input: HTMLInputElement): string | undefined {
  if (!input.value.trim()) {
    return copy.identity.common.required;
  }

  return input.validity.typeMismatch ? copy.identity.common.invalidEmail : undefined;
}

export function passwordError(value: string): string | undefined {
  if (!value) {
    return copy.identity.common.required;
  }

  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    return copy.identity.common.invalidPasswordLength;
  }

  return undefined;
}

export function confirmationError(password: string, confirmation: string): string | undefined {
  if (!confirmation) {
    return copy.identity.common.required;
  }

  return password === confirmation ? undefined : copy.identity.common.passwordsDoNotMatch;
}
