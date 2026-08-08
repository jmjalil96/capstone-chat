import type { GenerationModelTier, ModelTierPolicyResponse } from "@capstone/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { type ConversationQueryScope, conversationQueryKeys } from "../conversations/api";

export const availableModelTierPolicy = {
  defaultTier: "balanced",
  tiers: [
    { tier: "fast", enabled: true, available: true },
    { tier: "balanced", enabled: true, available: true },
    { tier: "pro", enabled: true, available: true },
  ],
} satisfies ModelTierPolicyResponse;

export function seedModelTierQueries(
  queryClient: QueryClient,
  queryScope: ConversationQueryScope,
  conversationIds: readonly string[],
  modelTier: GenerationModelTier = "balanced",
): void {
  queryClient.setQueryData(
    conversationQueryKeys.modelTierPolicy(queryScope),
    availableModelTierPolicy,
  );
  for (const conversationId of conversationIds) {
    queryClient.setQueryData(conversationQueryKeys.preferredTier(queryScope, conversationId), {
      conversationId,
      modelTier,
    });
  }
}
