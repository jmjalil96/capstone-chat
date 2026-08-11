import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../src/database/pool.js";
import { createApplicationLifecycle } from "../src/lifecycle.js";

function createPool(): DatabasePool & { query: ReturnType<typeof vi.fn> } {
  return {
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
  };
}

describe("application lifecycle readiness validation", () => {
  it("stays unavailable until the database and application authority are valid", async () => {
    const pool = createPool();
    const onReadyValidationFailure = vi.fn();
    const validateReady = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("policy is unavailable"))
      .mockResolvedValue(undefined);
    const lifecycle = createApplicationLifecycle(pool, {
      onReadyValidationFailure,
      validateReady,
    });

    await expect(lifecycle.initialize()).resolves.toEqual({
      database: "unknown",
      status: "unavailable",
    });
    expect(lifecycle.phase).toBe("unhealthy");
    expect(onReadyValidationFailure).toHaveBeenCalledOnce();

    await expect(lifecycle.checkReadiness()).resolves.toEqual({
      database: "up",
      status: "ready",
    });
    expect(validateReady).toHaveBeenCalledTimes(2);
    expect(onReadyValidationFailure).toHaveBeenCalledOnce();

    await expect(lifecycle.checkReadiness()).resolves.toEqual({
      database: "up",
      status: "ready",
    });
    expect(validateReady).toHaveBeenCalledTimes(2);
  });

  it("revalidates application authority after database recovery", async () => {
    const pool = createPool();
    const validateReady = vi.fn(async () => undefined);
    const lifecycle = createApplicationLifecycle(pool, { validateReady });

    await expect(lifecycle.initialize()).resolves.toEqual({
      database: "up",
      status: "ready",
    });
    pool.query.mockRejectedValueOnce(new Error("database is unavailable"));
    await expect(lifecycle.checkReadiness()).resolves.toEqual({
      database: "down",
      status: "unavailable",
    });
    await expect(lifecycle.checkReadiness()).resolves.toEqual({
      database: "up",
      status: "ready",
    });

    expect(validateReady).toHaveBeenCalledTimes(2);
  });
});
