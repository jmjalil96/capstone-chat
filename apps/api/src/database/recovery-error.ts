export class RecoveryPreparationError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RecoveryPreparationError";
  }
}

export function recoveryPreparationFailed(message: string, cause?: unknown): never {
  throw new RecoveryPreparationError(message, cause === undefined ? {} : { cause });
}
