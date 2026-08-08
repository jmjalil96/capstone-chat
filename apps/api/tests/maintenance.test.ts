import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCostControlMaintenance,
  type MaintenanceFailureMetadata,
} from "../src/model-policy/maintenance.js";
import { costControlTuning } from "../src/model-policy/settings.js";

const reconciliation = Object.freeze({ inspected: 1, settled: 1, terminalized: 1 });
const refresh = Object.freeze({ available: 2, claimed: 3, unavailable: 1, updated: 3 });

afterEach(() => {
  vi.useRealTimers();
});

describe("cost-control maintenance", () => {
  it("shares an in-flight pass and always reconciles before catalog refresh", async () => {
    const gate = Promise.withResolvers<void>();
    const phases: string[] = [];
    const budget = {
      reconcileExpiredOnce: vi.fn(async () => {
        phases.push("reconcile-start");
        await gate.promise;
        phases.push("reconcile-end");
        return reconciliation;
      }),
    };
    const refreshCatalog = vi.fn(async () => {
      phases.push("refresh");
      return refresh;
    });
    const maintenance = createCostControlMaintenance({ budget, refreshCatalog });

    const first = maintenance.runOnce();
    const overlapping = maintenance.runOnce();
    expect(overlapping).toBe(first);
    expect(budget.reconcileExpiredOnce).toHaveBeenCalledOnce();
    expect(refreshCatalog).not.toHaveBeenCalled();

    gate.resolve();
    await expect(first).resolves.toEqual({ catalogRefresh: refresh, reconciliation });
    expect(phases).toEqual(["reconcile-start", "reconcile-end", "refresh"]);
    expect(refreshCatalog).toHaveBeenCalledOnce();
  });

  it("isolates pass failures and reports only fixed categories and safe error names", async () => {
    const failures: MaintenanceFailureMetadata[] = [];
    const databaseFailure = new Error("sensitive database detail");
    databaseFailure.name = "DatabaseError";
    const unsafeProviderFailure = new Error("raw provider body");
    unsafeProviderFailure.name = "Provider payload: secret";
    const refreshCatalog = vi.fn(async () => {
      throw unsafeProviderFailure;
    });
    const maintenance = createCostControlMaintenance({
      budget: {
        async reconcileExpiredOnce() {
          throw databaseFailure;
        },
      },
      onFailure(metadata) {
        failures.push(metadata);
      },
      refreshCatalog,
    });

    await expect(maintenance.runOnce()).resolves.toEqual({
      catalogRefresh: null,
      reconciliation: null,
    });
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(failures).toEqual([
      { category: "reservation-reconciliation", errorName: "DatabaseError" },
      { category: "catalog-refresh", errorName: "UnknownError" },
    ]);
  });

  it("aborts and awaits an in-flight pass, and stopping is idempotent", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<AbortSignal>();
    const cleanup = Promise.withResolvers<void>();
    const maintenance = createCostControlMaintenance({
      budget: { reconcileExpiredOnce: async () => reconciliation },
      refreshCatalog: async (signal) => {
        entered.resolve(signal);
        await cleanup.promise;
        signal.throwIfAborted();
        return refresh;
      },
    });
    maintenance.start();
    const signal = await entered.promise;

    const firstStop = maintenance.stop();
    const secondStop = maintenance.stop();
    expect(secondStop).toBe(firstStop);
    expect(signal.aborted).toBe(true);
    let stopSettled = false;
    void firstStop.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    cleanup.resolve();
    await firstStop;
    expect(stopSettled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(maintenance.runOnce()).resolves.toEqual({
      catalogRefresh: null,
      reconciliation: null,
    });
  });

  it("uses the centralized 30-second cadence and clears its timer on stop", async () => {
    vi.useFakeTimers();
    const budget = { reconcileExpiredOnce: vi.fn(async () => reconciliation) };
    const maintenance = createCostControlMaintenance({
      budget,
      refreshCatalog: async () => refresh,
    });

    maintenance.start();
    await maintenance.runOnce();
    expect(costControlTuning.reconciliationIntervalMs).toBe(30_000);
    expect(budget.reconcileExpiredOnce).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(costControlTuning.reconciliationIntervalMs - 1);
    expect(budget.reconcileExpiredOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.reconcileExpiredOnce).toHaveBeenCalledTimes(2);

    await maintenance.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
