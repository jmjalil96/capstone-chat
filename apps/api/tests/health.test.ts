import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabasePool } from "../src/database/pool.js";

function createPool(): DatabasePool & {
  end: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  return {
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
  };
}

function createTestApplication(pool: DatabasePool) {
  return createApplication(loadConfig({ NODE_ENV: "test" }), {
    pool,
    requestIdFactory: () => "request-123",
  });
}

describe("health routes", () => {
  it("reports liveness without querying PostgreSQL", async () => {
    const pool = createPool();
    pool.query.mockRejectedValue(new Error("database is unavailable"));
    const application = createTestApplication(pool);

    const response = await application.server.inject({
      method: "GET",
      url: "/api/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
    expect(response.headers["x-request-id"]).toBe("request-123");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(pool.query).not.toHaveBeenCalled();
    await application.shutdown();
  });

  it("is unavailable while startup has not completed", async () => {
    const pool = createPool();
    const application = createTestApplication(pool);

    const response = await application.server.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ database: "unknown", status: "unavailable" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(pool.query).not.toHaveBeenCalled();
    await application.shutdown();
  });

  it("reports ready after startup and unavailable after a database failure", async () => {
    const pool = createPool();
    const application = createTestApplication(pool);

    await expect(application.lifecycle.initialize()).resolves.toEqual({
      database: "up",
      status: "ready",
    });

    const readyResponse = await application.server.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json()).toEqual({ database: "up", status: "ready" });

    pool.query.mockRejectedValue(new Error("database is unavailable"));
    const unavailableResponse = await application.server.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toEqual({ database: "down", status: "unavailable" });
    expect(application.lifecycle.phase).toBe("unhealthy");
    await application.shutdown();
  });

  it("rejects readiness while draining", async () => {
    const pool = createPool();
    const application = createTestApplication(pool);
    await application.lifecycle.initialize();
    application.lifecycle.beginDraining();

    const response = await application.server.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ database: "unknown", status: "unavailable" });
    await application.shutdown();
  });

  it("uses the shared error envelope for unknown API routes", async () => {
    const pool = createPool();
    const application = createTestApplication(pool);

    const response = await application.server.inject({
      method: "GET",
      url: "/api/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "NOT_FOUND",
      message: "No se encontró el recurso solicitado.",
      requestId: "request-123",
    });
    expect(response.headers["x-request-id"]).toBe("request-123");
    await application.shutdown();
  });
});
