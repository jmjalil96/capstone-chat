import {
  buildSimulatedCatalogSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../../src/model-policy/catalog.js";
import type { ModelPolicyService } from "../../src/model-policy/service.js";

export const testTierOutputLimits = Object.freeze({
  balanced: 8_192,
  fast: 4_096,
  pro: 16_384,
}) satisfies Readonly<Record<ModelTier, number>>;

export async function bootstrapSimulatedModelPolicy(
  service: ModelPolicyService,
  workspaceIdentity: string,
  options: {
    readonly employeeActiveGenerationLimit?: number;
    readonly monthlyBudgetUsd?: string;
    readonly reservationMarginBasisPoints?: number;
  } = {},
): Promise<void> {
  const validatedAt = new Date();
  const catalog = Object.fromEntries(
    modelTiers.map((tier) => [
      tier,
      buildSimulatedCatalogSnapshot(
        initialTierModels[tier],
        testTierOutputLimits[tier],
        validatedAt,
      ),
    ]),
  ) as Record<ModelTier, ReturnType<typeof buildSimulatedCatalogSnapshot>>;

  await service.bootstrap({
    catalog: Object.freeze(catalog),
    employeeActiveGenerationLimit: options.employeeActiveGenerationLimit ?? 100,
    maximumOutputTokens: testTierOutputLimits,
    mode: "simulated",
    monthlyBudgetUsd: options.monthlyBudgetUsd ?? "100000",
    privacyAttestation: null,
    reservationMarginBasisPoints: options.reservationMarginBasisPoints ?? 2_000,
    workspaceIdentity,
  });
}
