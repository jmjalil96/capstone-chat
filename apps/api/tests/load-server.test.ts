import { describe, expect, it } from "vitest";
import type { GatewayEvent, GenerationRequest } from "../src/generations/model-gateway.js";
import { LoadModelGateway, loadFixtureSteps } from "../src/load/load-gateway.js";
import { initialTierModels } from "../src/model-policy/catalog.js";
import { testEffectiveParameters } from "./support/generation.js";

function request(
  message: string,
  purpose: "chat" | "compaction" | "title" = "chat",
): GenerationRequest {
  const base = {
    effectiveParameters: testEffectiveParameters(purpose, purpose === "chat" ? "balanced" : "fast"),
    history: [],
    message: { role: "user" as const, text: message },
    systemPrompt: { text: "Synthetic system prompt", version: "load-v1" },
  };
  if (purpose === "chat") {
    return { ...base, modelTier: "balanced", purpose };
  }
  if (purpose === "compaction") {
    return { ...base, modelTier: "fast", purpose };
  }
  return { ...base, modelTier: "fast", purpose };
}

describe("local load gateway", () => {
  it("publishes the provider-header boundary before a synthetic load script", async () => {
    const gateway = new LoadModelGateway();
    const iterator = gateway
      .stream(
        request("CAPSTONE_LOAD_V1:00000000-0000-4000-8000-000000000001:1:1:0:seed"),
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        transportElapsedMilliseconds: expect.any(Number),
        type: "response.headers",
      },
    });
    const remaining: GatewayEvent[] = [];
    for (;;) {
      const result = await iterator.next();
      if (result.done) {
        break;
      }
      remaining.push(result.value);
    }
    expect(remaining.find((event) => event.type === "content.delta")).toMatchObject({
      transportElapsedMilliseconds: expect.any(Number),
    });
    expect(remaining.at(-1)).toMatchObject({
      transportElapsedMilliseconds: expect.any(Number),
      type: "response.completed",
    });
  });

  it("echoes only the synthetic run canary in a normal deterministic response", () => {
    const steps = loadFixtureSteps(
      request("CAPSTONE_LOAD_V1:00000000-0000-4000-8000-000000000001:1:1:0:normal"),
    );
    expect(steps).toHaveLength(22);
    expect(steps[0]?.event.type).toBe("generation.metadata");
    expect(steps.at(-1)?.event.type).toBe("response.completed");
    expect(steps.at(-1)?.delayMilliseconds).toBe(5_000);
    expect(JSON.stringify(steps)).toContain(
      "LOAD_RESPONSE:00000000-0000-4000-8000-000000000001:1:1:0",
    );
  });

  it("provides bounded failure, cancellation, slow-reader, and compaction scripts", () => {
    const prefix = "CAPSTONE_LOAD_V1:00000000-0000-4000-8000-000000000001:1:1:0:";
    const failure = loadFixtureSteps(request(`${prefix}failure`));
    expect(failure).toHaveLength(7);
    expect(failure.at(-1)).toMatchObject({
      delayMilliseconds: 12_500,
      event: { type: "response.failed" },
    });
    expect(loadFixtureSteps(request(`${prefix}cancel`))).toHaveLength(22);
    expect(loadFixtureSteps(request(`${prefix}large`))).toHaveLength(822);
    expect(loadFixtureSteps(request(`${prefix}seed`))).toHaveLength(5);
    const slow = loadFixtureSteps(request(`${prefix}slow`));
    expect(slow).toHaveLength(98);
    expect(slow.at(-1)?.delayMilliseconds).toBe(15_000);
    expect(loadFixtureSteps(request("ignored", "compaction")).at(-1)?.event.type).toBe(
      "response.completed",
    );
    expect(loadFixtureSteps(request("ignored", "title"))).toMatchObject([
      { event: { type: "generation.metadata" } },
      { delayMilliseconds: 100, event: { type: "content.delta" } },
      { delayMilliseconds: 200, event: { type: "response.completed" } },
    ]);
  });

  it("fails closed for an ordinary message", () => {
    expect(loadFixtureSteps(request("ordinary employee content"))).toEqual([
      {
        event: {
          errorCode: "GENERATION_FAILED",
          providerErrorType: "invalid_prompt",
          type: "response.failed",
        },
      },
    ]);
  });

  it("settles cancellations while retaining the controlled failure reservation", async () => {
    const gateway = new LoadModelGateway();
    await expect(
      gateway.lookupUsage(
        "load-00000000-0000-4000-8000-000000000001-1-1-0-1",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      accounting: { metadata: { provider: "capstone-local-load" } },
      status: "found",
      usage: { inputTokens: 32, outputTokens: 4 },
    });
    await expect(
      gateway.lookupUsage(
        "load-00000000-0000-4000-8000-000000000001-1-2-0-2",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      gateway.lookupUsage(
        "load-00000000-0000-4000-8000-000000000001-0-2-0-3",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      gateway.lookupUsage("load-title-4", new AbortController().signal),
    ).resolves.toMatchObject({
      accounting: {
        metadata: {
          provider: "capstone-local-load",
          resolvedModel: initialTierModels.fast,
        },
      },
      status: "found",
    });
    await expect(
      gateway.lookupUsage("untrusted-provider-generation", new AbortController().signal),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
