const APPROVED_MESSAGE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isSafeMessageDestination(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    return APPROVED_MESSAGE_PROTOCOLS.has(new URL(value).protocol.toLowerCase());
  } catch {
    return false;
  }
}
