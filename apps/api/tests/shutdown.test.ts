import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabasePool } from "../src/database/pool.js";

describe("graceful shutdown", () => {
  it("stops HTTP and closes the database pool once", async () => {
    const end = vi.fn(async () => undefined);
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), { pool });

    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    expect(application.server.server.listening).toBe(true);

    await Promise.all([application.shutdown(), application.shutdown()]);

    expect(application.server.server.listening).toBe(false);
    expect(application.lifecycle.phase).toBe("stopped");
    expect(end).toHaveBeenCalledTimes(1);
  });
});
