import { describe, expect, it, vi } from "vitest";
import type { AppDatabase, AppTransaction } from "../src/database/database.js";
import { createTitleService } from "../src/generations/title-service.js";
import type { BudgetService } from "../src/model-policy/budget-service.js";
import type { ModelPolicyService, ResolvedTierPolicy } from "../src/model-policy/service.js";
import { testCatalogCapability } from "./support/generation.js";

describe("hidden title policy", () => {
  it("skips mandatory-reasoning Fast models before reservation or generation insertion", async () => {
    const mandatoryPolicy: ResolvedTierPolicy = Object.freeze({
      capability: Object.freeze({
        ...testCatalogCapability,
        reasoning: Object.freeze({
          ...testCatalogCapability.reasoning,
          kind: "mandatory",
        }),
      }),
      completionPriceCeilingPerToken: "0.000002",
      contextLength: 128_000,
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: 4_096,
      monthlyBudgetUsd: "100",
      policyRevision: 7,
      promptPriceCeilingPerToken: "0.000001",
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      requestPriceCeilingUsd: "0",
      reservationMarginBasisPoints: 0,
      resolvedModel: "fixture/mandatory-fast",
      temperaturePreset: "precise",
      tier: "fast",
    });
    const resolveHiddenFastAdmission = vi.fn(async () => ({
      admission: Object.freeze({}),
      fast: mandatoryPolicy,
    }));
    const reserveResolvedTier = vi.fn();
    const insert = vi.fn(() => {
      throw new Error("mandatory title skip must not insert");
    });
    const service = createTitleService({
      budget: { reserveResolvedTier } as unknown as BudgetService,
      database: {} as AppDatabase,
      mode: "openrouter",
      modelPolicy: { resolveHiddenFastAdmission } as unknown as ModelPolicyService,
    });

    await expect(
      service.beginNaming({ insert } as unknown as AppTransaction, {
        answer: "Respuesta",
        completedAt: new Date(),
        conversationId: "11111111-1111-4111-8111-111111111111",
        prompt: "Pregunta",
        userId: "employee-id",
        workspaceId: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toBeNull();
    expect(resolveHiddenFastAdmission).toHaveBeenCalledOnce();
    expect(reserveResolvedTier).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
