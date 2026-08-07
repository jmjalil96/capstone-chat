const approvalEmailPattern =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u;

export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFC").toLowerCase();
}

export function normalizeApprovalEmail(email: string): string {
  const normalized = normalizeEmail(email);

  if (normalized.length > 320 || !approvalEmailPattern.test(normalized)) {
    throw new Error("Employee email must be a valid email address");
  }

  return normalized;
}
