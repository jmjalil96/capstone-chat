import type { ReconciliationResult } from "./budget-service.js";
import type { CatalogRefreshSummary } from "./catalog-refresh.js";
import { costControlTuning } from "./settings.js";

export type MaintenanceFailureCategory = "catalog-refresh" | "reservation-reconciliation";

export interface MaintenanceFailureMetadata {
  readonly category: MaintenanceFailureCategory;
  readonly errorName: string;
}

export interface MaintenancePassResult {
  readonly catalogRefresh: CatalogRefreshSummary | null;
  readonly reconciliation: ReconciliationResult | null;
}

interface MaintenanceBudget {
  reconcileExpiredOnce(): Promise<ReconciliationResult>;
}

export interface CostControlMaintenanceOptions {
  readonly budget: MaintenanceBudget;
  readonly onFailure?: ((metadata: MaintenanceFailureMetadata) => void) | undefined;
  readonly refreshCatalog: (signal: AbortSignal) => Promise<CatalogRefreshSummary>;
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
  let activePass: Promise<MaintenancePassResult> | undefined;
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  function report(category: MaintenanceFailureCategory, error: unknown): void {
    try {
      options.onFailure?.({ category, errorName: safeErrorName(error) });
    } catch {
      // Operational reporting must not disable cost-control recovery.
    }
  }

  function schedule(): void {
    if (!started || stopped || timer !== undefined || activePass !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, costControlTuning.reconciliationIntervalMs);
    timer.unref();
  }

  async function performPass(signal: AbortSignal): Promise<MaintenancePassResult> {
    let reconciliation: ReconciliationResult | null = null;
    let catalogRefresh: CatalogRefreshSummary | null = null;

    try {
      reconciliation = await options.budget.reconcileExpiredOnce();
    } catch (error: unknown) {
      report("reservation-reconciliation", error);
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

    return Object.freeze({ catalogRefresh, reconciliation });
  }

  function runOnce(): Promise<MaintenancePassResult> {
    if (activePass !== undefined) {
      return activePass;
    }
    if (stopped) {
      return Promise.resolve(Object.freeze({ catalogRefresh: null, reconciliation: null }));
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const controller = new AbortController();
    activeController = controller;
    const currentPass = performPass(controller.signal).finally(() => {
      if (activePass === currentPass) {
        activeController = undefined;
        activePass = undefined;
        schedule();
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
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      activeController?.abort(new DOMException("Cost-control maintenance stopped", "AbortError"));
      await activePass;
    })();
    return stopPromise;
  }

  return Object.freeze({ runOnce, start, stop });
}
