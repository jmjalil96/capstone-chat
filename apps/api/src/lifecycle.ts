import type { ReadinessResponse } from "@capstone/protocol";
import type { DatabasePool } from "./database/pool.js";

export type LifecyclePhase = "starting" | "ready" | "unhealthy" | "draining" | "stopped";

export interface ApplicationLifecycle {
  readonly phase: LifecyclePhase;
  beginDraining(): void;
  checkReadiness(): Promise<ReadinessResponse>;
  initialize(): Promise<ReadinessResponse>;
  markStopped(): void;
}

export interface ApplicationLifecycleOptions {
  readonly onReadyValidationFailure?: (error: unknown) => void;
  readonly validateReady?: () => Promise<void>;
}

const unavailable = (database: "down" | "unknown"): ReadinessResponse => ({
  database,
  status: "unavailable",
});

export function createApplicationLifecycle(
  pool: DatabasePool,
  options: ApplicationLifecycleOptions = {},
): ApplicationLifecycle {
  let phase: LifecyclePhase = "starting";
  let readyValidationPassed = options.validateReady === undefined;
  let readyValidationFailureReported = false;

  async function probeDatabase(): Promise<ReadinessResponse> {
    try {
      await pool.query("SELECT 1");
    } catch {
      readyValidationPassed = options.validateReady === undefined;
      if (phase !== "draining" && phase !== "stopped") {
        phase = "unhealthy";
      }

      return unavailable("down");
    }

    if (phase === "draining" || phase === "stopped") {
      return unavailable("unknown");
    }

    if (!readyValidationPassed && options.validateReady !== undefined) {
      try {
        await options.validateReady();
        readyValidationPassed = true;
        readyValidationFailureReported = false;
      } catch (error: unknown) {
        if (!readyValidationFailureReported) {
          try {
            options.onReadyValidationFailure?.(error);
          } catch {
            // Operational reporting cannot make the readiness boundary throw.
          }
          readyValidationFailureReported = true;
        }
        phase = "unhealthy";
        return unavailable("unknown");
      }
    }

    phase = "ready";
    return { database: "up", status: "ready" };
  }

  return {
    get phase() {
      return phase;
    },
    beginDraining() {
      if (phase !== "stopped") {
        phase = "draining";
      }
    },
    async checkReadiness() {
      if (phase === "starting" || phase === "draining" || phase === "stopped") {
        return unavailable("unknown");
      }

      return probeDatabase();
    },
    async initialize() {
      if (phase !== "starting") {
        return phase === "ready" || phase === "unhealthy"
          ? probeDatabase()
          : unavailable("unknown");
      }

      return probeDatabase();
    },
    markStopped() {
      phase = "stopped";
    },
  };
}
