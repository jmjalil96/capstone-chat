import { describe, expect, it, vi } from "vitest";
import { loadEntrypoint } from "../src/entrypoint-loader.js";

describe("API executable bootstrap", () => {
  it("loads and validates the environment before importing a normal target", async () => {
    const order: string[] = [];
    await loadEntrypoint(
      () => order.push("environment"),
      async () => {
        order.push("target");
      },
    );

    expect(order).toEqual(["environment", "target"]);
  });

  it("never imports a target when strict environment loading fails", async () => {
    const importTarget = vi.fn(async () => undefined);

    await expect(
      loadEntrypoint(() => {
        throw new Error("invalid secret file");
      }, importTarget),
    ).rejects.toThrow("invalid secret file");
    expect(importTarget).not.toHaveBeenCalled();
  });
});
