interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
}

export function isPostgresError(error: unknown, code: string, constraint?: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    const candidate = current as PostgresErrorLike;
    if (
      candidate.code === code &&
      (constraint === undefined || candidate.constraint === constraint)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
