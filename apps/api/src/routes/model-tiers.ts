import { ApiErrorSchema, ModelTierPolicyResponseSchema } from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import type { ModelGatewayMode } from "../config.js";
import type { ActorResolver } from "../identity/authorization.js";
import type { ModelPolicyService } from "../model-policy/service.js";
import { resolveMember } from "./member.js";

const ordinaryErrorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  500: ApiErrorSchema,
} as const;

export function registerModelTierRoutes(
  fastify: FastifyInstance,
  dependencies: {
    readonly modelGateway: ModelGatewayMode;
    readonly modelPolicy: ModelPolicyService;
    readonly resolveActor: ActorResolver;
  },
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    "/api/model-tiers",
    {
      schema: {
        response: { 200: ModelTierPolicyResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      const mode = dependencies.modelGateway === "openrouter" ? "openrouter" : "simulated";
      const policy = await dependencies.modelPolicy.readEmployeeTierPolicy(
        actor.workspace.id,
        mode,
      );
      const fast = policy.tiers.find(({ tier }) => tier === "fast");
      const balanced = policy.tiers.find(({ tier }) => tier === "balanced");
      const pro = policy.tiers.find(({ tier }) => tier === "pro");
      if (fast === undefined || balanced === undefined || pro === undefined) {
        throw new Error("Model policy did not return the complete tier catalog");
      }
      return reply.code(200).send({
        defaultTier: policy.defaultTier,
        tiers: [fast, balanced, pro],
      });
    },
  );
}
