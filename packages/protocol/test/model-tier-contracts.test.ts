import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ConversationPreferredTierResponseSchema,
  ModelTierPolicyResponseSchema,
  UpdateConversationPreferredTierRequestSchema,
  UpdateConversationPreferredTierResponseSchema,
} from "../src/index.js";

const conversationId = "aaedb175-c593-4d66-87d6-636fca2aa4fa";

const policy = {
  defaultTier: "balanced",
  tiers: [
    { tier: "fast", enabled: true, available: true },
    { tier: "balanced", enabled: true, available: true },
    { tier: "pro", enabled: true, available: false },
  ],
} as const;

describe("employee model-tier contracts", () => {
  it("accepts exactly the three employee tiers in stable order", () => {
    expect(Value.Check(ModelTierPolicyResponseSchema, policy)).toBe(true);
    expect(
      Value.Check(ModelTierPolicyResponseSchema, {
        ...policy,
        tiers: [...policy.tiers].reverse(),
      }),
    ).toBe(false);
    expect(
      Value.Check(ModelTierPolicyResponseSchema, {
        ...policy,
        tiers: policy.tiers.slice(0, 2),
      }),
    ).toBe(false);
  });

  it("keeps policy responses content-free and closed", () => {
    expect(
      Value.Check(ModelTierPolicyResponseSchema, {
        ...policy,
        modelId: "provider/private-model",
      }),
    ).toBe(false);
    expect(
      Value.Check(ModelTierPolicyResponseSchema, {
        ...policy,
        tiers: [
          { ...policy.tiers[0], reason: "provider rejected request" },
          policy.tiers[1],
          policy.tiers[2],
        ],
      }),
    ).toBe(false);
  });

  it.each(["fast", "balanced", "pro"])("accepts a narrow %s preference", (modelTier) => {
    const response = { conversationId, modelTier };
    expect(Value.Check(ConversationPreferredTierResponseSchema, response)).toBe(true);
    expect(Value.Check(UpdateConversationPreferredTierRequestSchema, { modelTier })).toBe(true);
    expect(Value.Check(UpdateConversationPreferredTierResponseSchema, response)).toBe(true);
  });

  it("rejects raw model identifiers and additional preference fields", () => {
    expect(
      Value.Check(UpdateConversationPreferredTierRequestSchema, {
        modelTier: "deepseek/deepseek-v4-pro",
      }),
    ).toBe(false);
    expect(
      Value.Check(UpdateConversationPreferredTierRequestSchema, {
        modelTier: "pro",
        modelId: "provider/private-model",
      }),
    ).toBe(false);
    expect(
      Value.Check(ConversationPreferredTierResponseSchema, {
        conversationId,
        modelTier: "pro",
        cost: "0.01",
      }),
    ).toBe(false);
  });
});
