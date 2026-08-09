import { describe, expect, it } from "vitest";
import type { GatewayEvent, GenerationRequest } from "../src/generations/model-gateway.js";
import { LoadModelGateway, loadRehearsalSteps } from "../src/load/load-gateway.js";

function request(message: string, purpose: "chat" | "compaction" = "chat"): GenerationRequest {
  const base = {
    history: [],
    message: { role: "user" as const, text: message },
    modelTier: purpose === "chat" ? ("balanced" as const) : ("fast" as const),
    purpose,
    systemPrompt: { text: "Synthetic system prompt", version: "load-v1" },
  };
  return base as GenerationRequest;
}

describe("load rehearsal gateway", () => {
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
    const steps = loadRehearsalSteps(
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
    const failure = loadRehearsalSteps(request(`${prefix}failure`));
    expect(failure).toHaveLength(7);
    expect(failure.at(-1)).toMatchObject({
      delayMilliseconds: 12_500,
      event: { type: "response.failed" },
    });
    expect(loadRehearsalSteps(request(`${prefix}cancel`))).toHaveLength(22);
    expect(loadRehearsalSteps(request(`${prefix}large`))).toHaveLength(822);
    expect(loadRehearsalSteps(request(`${prefix}seed`))).toHaveLength(5);
    const slow = loadRehearsalSteps(request(`${prefix}slow`));
    expect(slow).toHaveLength(98);
    expect(slow.at(-1)?.delayMilliseconds).toBe(15_000);
    expect(loadRehearsalSteps(request("ignored", "compaction")).at(-1)?.event.type).toBe(
      "response.completed",
    );
  });

  it("fails closed for an ordinary message", () => {
    expect(loadRehearsalSteps(request("ordinary employee content"))).toEqual([
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
      accounting: { metadata: { provider: "capstone-load-rehearsal" } },
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
      gateway.lookupUsage("untrusted-provider-generation", new AbortController().signal),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
