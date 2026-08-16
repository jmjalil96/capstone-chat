import type { ApplicationTelemetry } from "../observability/telemetry-contract.js";
import type { ReconciliationResult } from "./budget-service.js";
import type { CatalogRefreshSummary } from "./catalog-refresh.js";
import { costControlTuning } from "./settings.js";

export type MaintenanceFailureCategory =
  | "catalog-refresh"
  | "naming-reconciliation"
  | "reservation-reconciliation";

export interface MaintenanceFailureMetadata {
  readonly category: MaintenanceFailureCategory;
  readonly errorName: string;
}

export interface NamingReconciliationResult {
  readonly finalized: number;
  readonly inspected: number;
}

export interface MaintenancePassResult {
  readonly catalogRefresh: CatalogRefreshSummary | null;
  readonly namingReconciliation: NamingReconciliationResult | null;
  readonly reconciliation: ReconciliationResult | null;
}

interface MaintenanceBudget {
  reconcileExpiredOnce(): Promise<ReconciliationResult>;
}

export interface CostControlMaintenanceOptions {
  readonly budget: MaintenanceBudget;
  readonly onFailure?: ((metadata: MaintenanceFailureMetadata) => void) | undefined;
  /** Bounded finalization of parents left in the naming phase past their deadline. */
  readonly reconcileNaming?: (() => Promise<NamingReconciliationResult>) | undefined;
  readonly refreshCatalog: (signal: AbortSignal) => Promise<CatalogRefreshSummary>;
  readonly telemetry?: Pick<ApplicationTelemetry, "recordReconciliation"> | undefined;
}

export interface CostControlMaintenance {
  runOnce(): Promise<MaintenancePassResult>;
  start(): void;
  stop(): Promise<void>;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : "UnknownError";
}

export function createCostControlMaintenance(
  options: CostControlMaintenanceOptions,
): CostControlMaintenance {
  let activeController: AbortController | undefined;
  let activeNamingPass: Promise<NamingReconciliationResult | null> | undefined;
  let activePass: Promise<MaintenancePassResult> | undefined;
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let namingTimer: NodeJS.Timeout | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined;

  function report(category: MaintenanceFailureCategory, error: unknown): void {
    try {
      options.onFailure?.({ category, errorName: safeErrorName(error) });
    } catch {
      // Operational reporting must not disable cost-control recovery.
    }
  }

  function scheduleReconciliation(): void {
    if (!started || stopped || reconciliationTimer !== undefined || activePass !== undefined) {
      return;
    }
    reconciliationTimer = setTimeout(() => {
      reconciliationTimer = undefined;
      void runOnce();
    }, costControlTuning.reconciliationIntervalMs);
    reconciliationTimer.unref();
  }

  function scheduleNaming(): void {
    if (
      options.reconcileNaming === undefined ||
      !started ||
      stopped ||
      namingTimer !== undefined ||
      activeNamingPass !== undefined
    ) {
      return;
    }
    namingTimer = setTimeout(() => {
      namingTimer = undefined;
      void runNamingOnce();
    }, costControlTuning.namingReconciliationIntervalMs);
    namingTimer.unref();
  }

  async function performNamingPass(): Promise<NamingReconciliationResult | null> {
    if (options.reconcileNaming === undefined) {
      return null;
    }
    try {
      return await options.reconcileNaming();
    } catch (error: unknown) {
      report("naming-reconciliation", error);
      return null;
    }
  }

  function runNamingOnce(): Promise<NamingReconciliationResult | null> {
    if (activeNamingPass !== undefined) {
      return activeNamingPass;
    }
    if (stopped || options.reconcileNaming === undefined) {
      return Promise.resolve(null);
    }
    if (namingTimer !== undefined) {
      clearTimeout(namingTimer);
      namingTimer = undefined;
    }

    const currentPass = performNamingPass().finally(() => {
      if (activeNamingPass === currentPass) {
        activeNamingPass = undefined;
        scheduleNaming();
      }
    });
    activeNamingPass = currentPass;
    return currentPass;
  }

  async function performPass(signal: AbortSignal): Promise<MaintenancePassResult> {
    let reconciliation: ReconciliationResult | null = null;
    const namingReconciliation = signal.aborted ? null : await runNamingOnce();
    let catalogRefresh: CatalogRefreshSummary | null = null;

    if (!signal.aborted) {
      try {
        reconciliation = await options.budget.reconcileExpiredOnce();
      } catch (error: unknown) {
        try {
          options.telemetry?.recordReconciliation({
            claimed: 0,
            errors: 1,
            oldestDueLagMs: 0,
            settled: 0,
          });
        } catch {
          // Telemetry cannot affect cost-control recovery.
        }
        report("reservation-reconciliation", error);
      }
    }

    if (!signal.aborted) {
      try {
        catalogRefresh = await options.refreshCatalog(signal);
      } catch (error: unknown) {
        if (!signal.aborted) {
          report("catalog-refresh", error);
        }
      }
    }

    return Object.freeze({ catalogRefresh, namingReconciliation, reconciliation });
  }

  function runOnce(): Promise<MaintenancePassResult> {
    if (activePass !== undefined) {
      return activePass;
    }
    if (stopped) {
      return Promise.resolve(
        Object.freeze({ catalogRefresh: null, namingReconciliation: null, reconciliation: null }),
      );
    }
    if (reconciliationTimer !== undefined) {
      clearTimeout(reconciliationTimer);
      reconciliationTimer = undefined;
    }

    const controller = new AbortController();
    activeController = controller;
    const currentPass = performPass(controller.signal).finally(() => {
      if (activePass === currentPass) {
        activeController = undefined;
        activePass = undefined;
        scheduleReconciliation();
      }
    });
    activePass = currentPass;
    return currentPass;
  }

  function start(): void {
    if (started || stopped) {
      return;
    }
    started = true;
    void runOnce();
  }

  function stop(): Promise<void> {
    stopPromise ??= (async () => {
      stopped = true;
      if (reconciliationTimer !== undefined) {
        clearTimeout(reconciliationTimer);
        reconciliationTimer = undefined;
      }
      if (namingTimer !== undefined) {
        clearTimeout(namingTimer);
        namingTimer = undefined;
      }
      activeController?.abort(new DOMException("Cost-control maintenance stopped", "AbortError"));
      await Promise.all([activePass, activeNamingPass]);
    })();
    return stopPromise;
  }

  return Object.freeze({ runOnce, start, stop });
}
