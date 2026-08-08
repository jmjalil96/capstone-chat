import Type from "typebox";
import { ConversationIdSchema } from "./conversation.js";
import { GenerationModelTierSchema } from "./generation.js";

const ModelTierAvailabilitySchema = (tier: "fast" | "balanced" | "pro") =>
  Type.Object(
    {
      tier: Type.Literal(tier),
      enabled: Type.Boolean(),
      available: Type.Boolean(),
    },
    { additionalProperties: false },
  );

export const ModelTierPolicyResponseSchema = Type.Object(
  {
    defaultTier: GenerationModelTierSchema,
    tiers: Type.Tuple([
      ModelTierAvailabilitySchema("fast"),
      ModelTierAvailabilitySchema("balanced"),
      ModelTierAvailabilitySchema("pro"),
    ]),
  },
  { additionalProperties: false },
);
export type ModelTierPolicyResponse = Type.Static<typeof ModelTierPolicyResponseSchema>;

export const ConversationPreferredTierResponseSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    modelTier: GenerationModelTierSchema,
  },
  { additionalProperties: false },
);
export type ConversationPreferredTierResponse = Type.Static<
  typeof ConversationPreferredTierResponseSchema
>;

export const UpdateConversationPreferredTierRequestSchema = Type.Object(
  { modelTier: GenerationModelTierSchema },
  { additionalProperties: false },
);
export type UpdateConversationPreferredTierRequest = Type.Static<
  typeof UpdateConversationPreferredTierRequestSchema
>;

export const UpdateConversationPreferredTierResponseSchema =
  ConversationPreferredTierResponseSchema;
export type UpdateConversationPreferredTierResponse = Type.Static<
  typeof UpdateConversationPreferredTierResponseSchema
>;
