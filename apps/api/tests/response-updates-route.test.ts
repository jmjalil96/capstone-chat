import { request as httpRequest } from "node:http";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import type { ResponseStreamCoordinator } from "../src/generations/response-stream.js";
import {
  ResponseUpdatesRequestAborted,
  type ResponseUpdatesService,
} from "../src/generations/response-updates.js";
import type { GenerationService } from "../src/generations/service.js";
import type { ActorResolver, RequestActor } from "../src/identity/authorization.js";
import { registerResponseRoutes } from "../src/routes/responses.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";

const actor: RequestActor = Object.freeze({
  employee: Object.freeze({ email: "member@example.test", id: "member", name: "Member" }),
  role: "member",
  session: Object.freeze({
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    id: "member-session",
  }),
  workspace: Object.freeze({ id: conversationId, identity: "synthetic", name: "Synthetic" }),
});

const resolveActor: ActorResolver = async () => ({
  actor,
  authenticationHeaders: new Headers(),
});

describe("response updates route lifecycle", () => {
  it("aborts a current long poll when the response socket closes", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const readUpdates = vi.fn<ResponseUpdatesService["readUpdates"]>(
      async (_actor, _conversationId, _generationId, _cursor, options) => {
        entered.resolve();
        const signal = options?.signal;
        if (signal === undefined) {
          throw new Error("The route did not provide its downstream signal");
        }
        if (signal.aborted) {
          aborted.resolve();
          throw new ResponseUpdatesRequestAborted();
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          );
        });
        throw new ResponseUpdatesRequestAborted();
      },
    );
    const server = Fastify({ logger: false }).setValidatorCompiler(TypeBoxValidatorCompiler);
    registerResponseRoutes(server, {
      generations: {} as GenerationService,
      registry: { isAccepting: true } as ActiveStreamRegistry,
      resolveActor,
      streams: {} as ResponseStreamCoordinator,
      updates: { readUpdates },
    });

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      const request = httpRequest(
        `${address}/api/conversations/${conversationId}/responses/${generationId}/updates`,
        {
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      request.on("error", () => undefined);
      request.end(JSON.stringify({ cursor: null }));
      await entered.promise;
      request.destroy();

      await expect(
        Promise.race([
          aborted.promise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
        ]),
      ).resolves.toBe(true);
      expect(readUpdates).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
