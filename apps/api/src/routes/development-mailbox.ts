import { ApiErrorSchema, DevelopmentMailboxResponseSchema } from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import type { ApiConfig } from "../config.js";
import type { FakeEmailSender } from "../identity/email.js";

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function registerDevelopmentMailboxRoute(
  fastify: FastifyInstance,
  config: ApiConfig,
  sender: FakeEmailSender,
): void {
  if (config.nodeEnv !== "development") {
    return;
  }

  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();
  server.get(
    "/api/dev/mailbox",
    {
      schema: {
        response: {
          200: DevelopmentMailboxResponseSchema,
          403: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (request, reply) => {
      void reply.header("cache-control", "no-store");

      if (!isLoopback(request.ip)) {
        void reply.code(403);
        return {
          code: "DEVELOPMENT_MAILBOX_DENIED" as const,
          message: "El buzón local solo está disponible desde este equipo.",
          requestId: request.id,
        };
      }

      void reply.code(200);
      return { messages: [...sender.deliveries()] };
    },
  );
}
