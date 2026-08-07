import type { FastifyReply, FastifyRequest } from "fastify";
import { createTrustedAuthHeaders, forwardAuthenticationCookies } from "../auth/request-headers.js";
import {
  type ActorResolver,
  type RequestActor,
  requireMemberActor,
} from "../identity/authorization.js";

export async function resolveMember(
  request: FastifyRequest,
  reply: FastifyReply,
  resolveActor: ActorResolver,
): Promise<RequestActor> {
  void reply.header("cache-control", "no-store");
  const resolution = await resolveActor(createTrustedAuthHeaders(request));
  forwardAuthenticationCookies(resolution.authenticationHeaders, reply);
  return requireMemberActor(resolution.actor);
}
