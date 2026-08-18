import {
  AdminAddModelCatalogRequestSchema,
  AdminAddModelCatalogResponseSchema,
  AdminModelCatalogListQuerySchema,
  AdminModelCatalogListResponseSchema,
  AdminModelPolicyHistoryQuerySchema,
  AdminModelPolicyHistoryResponseSchema,
  AdminModelPolicyResponseSchema,
  AdminModelPolicyRevisionParamsSchema,
  AdminRefreshModelCatalogRequestSchema,
  AdminRefreshModelCatalogResponseSchema,
  AdminRevertModelPolicyRequestSchema,
  AdminUpdateModelPolicyRequestSchema,
  AdminUpdateModelPolicyResponseSchema,
  ApiErrorSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModelGatewayMode } from "../config.js";
import { ApplicationError } from "../errors.js";
import {
  type ActorResolver,
  type RequestActor,
  requireAdministratorRole,
  requireFreshAdministratorActor,
} from "../identity/authorization.js";
import type { CatalogModelSnapshot } from "../model-policy/catalog.js";
import type { CatalogSnapshotLoader } from "../model-policy/catalog-refresh.js";
import {
  CatalogRefreshActiveError,
  ModelPolicyChangedError,
  ModelPolicyConflictError,
  ModelPolicyRevisionNotFoundError,
  type ModelPolicyService,
  ModelPolicyUnavailableError,
} from "../model-policy/service.js";
import { resolveMember } from "./member.js";

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  422: ApiErrorSchema,
  500: ApiErrorSchema,
  503: ApiErrorSchema,
} as const;

const modelAdministrationCopy = {
  catalogRefreshActive: "Ya hay una actualización de este catálogo en curso.",
  modelPolicyChanged: "La política cambió. Recarga la información e inténtalo de nuevo.",
  modelPolicyConflict: "La política de modelos y presupuesto no puede guardar esos cambios.",
  modelValidationFailed: "No se pudo validar el modelo solicitado con los requisitos de Capstone.",
} as const;

type AdminModelPolicyStore = Pick<
  ModelPolicyService,
  | "approveCatalogSnapshot"
  | "claimAdminCatalogRefresh"
  | "completeCatalogRefresh"
  | "listAdminCatalog"
  | "listAdminPolicyHistory"
  | "readAdminPolicy"
  | "releaseCatalogRefresh"
  | "replaceAdminPolicy"
  | "revertAdminPolicy"
>;
type AdminCatalogRefreshClaim = Awaited<
  ReturnType<AdminModelPolicyStore["claimAdminCatalogRefresh"]>
>;

export interface AdminModelRoutesDependencies {
  readonly loadCatalogSnapshots?: CatalogSnapshotLoader;
  readonly modelGateway: ModelGatewayMode;
  readonly modelPolicy: AdminModelPolicyStore;
  readonly ownerIdFactory: () => string;
  readonly resolveActor: ActorResolver;
}

function mode(dependencies: AdminModelRoutesDependencies): "openrouter" | "simulated" {
  return dependencies.modelGateway === "openrouter" ? "openrouter" : "simulated";
}

async function resolveAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  resolveActor: ActorResolver,
  fresh: boolean,
): Promise<RequestActor> {
  const member = await resolveMember(request, reply, resolveActor);
  return fresh ? requireFreshAdministratorActor(member) : requireAdministratorRole(member);
}

function translateModelPolicyError(error: unknown): never {
  if (error instanceof ApplicationError) {
    throw error;
  }
  if (error instanceof CatalogRefreshActiveError) {
    throw new ApplicationError(
      409,
      "CATALOG_REFRESH_ACTIVE",
      modelAdministrationCopy.catalogRefreshActive,
    );
  }
  if (error instanceof ModelPolicyChangedError) {
    throw new ApplicationError(
      409,
      "MODEL_POLICY_CHANGED",
      modelAdministrationCopy.modelPolicyChanged,
    );
  }
  if (error instanceof ModelPolicyRevisionNotFoundError) {
    throw new ApplicationError(404, "NOT_FOUND", "No se encontró la revisión solicitada.");
  }
  if (error instanceof ModelPolicyConflictError || error instanceof ModelPolicyUnavailableError) {
    throw new ApplicationError(
      409,
      "MODEL_POLICY_CONFLICT",
      modelAdministrationCopy.modelPolicyConflict,
    );
  }
  throw error;
}

function validationFailure(statusCode: 422 | 503): ApplicationError {
  return new ApplicationError(
    statusCode,
    "MODEL_VALIDATION_FAILED",
    modelAdministrationCopy.modelValidationFailed,
  );
}

async function loadForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  loader: CatalogSnapshotLoader | undefined,
  modelIds: readonly string[],
) {
  if (loader === undefined) {
    throw validationFailure(503);
  }
  const controller = new AbortController();
  const aborted = (): void => {
    controller.abort(new DOMException("Catalog request was aborted", "AbortError"));
  };
  const disconnected = (): void => {
    if (!reply.raw.writableFinished) {
      aborted();
    }
  };
  request.raw.once("aborted", aborted);
  reply.raw.once("close", disconnected);
  try {
    return await loader(Object.freeze([...modelIds]), controller.signal);
  } finally {
    request.raw.removeListener("aborted", aborted);
    reply.raw.removeListener("close", disconnected);
  }
}

export function registerAdminModelRoutes(
  fastify: FastifyInstance,
  dependencies: AdminModelRoutesDependencies,
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    "/api/admin/model-catalog",
    {
      schema: {
        querystring: AdminModelCatalogListQuerySchema,
        response: { 200: AdminModelCatalogListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.modelPolicy.listAdminCatalog(
              actor.workspace.id,
              request.query.cursor,
            ),
          );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
    },
  );

  server.post(
    "/api/admin/model-catalog",
    {
      bodyLimit: 2_048,
      schema: {
        body: AdminAddModelCatalogRequestSchema,
        response: { 200: AdminAddModelCatalogResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      const gatewayMode = mode(dependencies);
      if (gatewayMode !== "openrouter") {
        return translateModelPolicyError(
          new ModelPolicyConflictError("Catalog add requires OpenRouter mode"),
        );
      }
      let snapshots: readonly CatalogModelSnapshot[];
      try {
        snapshots = await loadForRequest(request, reply, dependencies.loadCatalogSnapshots, [
          request.body.modelId,
        ]);
      } catch (error: unknown) {
        if (error instanceof ApplicationError) {
          throw error;
        }
        throw validationFailure(503);
      }
      const snapshot =
        snapshots.length === 1 && snapshots[0]?.modelId === request.body.modelId
          ? snapshots[0]
          : undefined;
      if (snapshot === undefined) {
        throw validationFailure(422);
      }
      try {
        return reply
          .code(200)
          .send(
            await dependencies.modelPolicy.approveCatalogSnapshot(
              actor.workspace.id,
              gatewayMode,
              snapshot,
            ),
          );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
    },
  );

  server.post(
    "/api/admin/model-catalog/refresh",
    {
      bodyLimit: 2_048,
      schema: {
        body: AdminRefreshModelCatalogRequestSchema,
        response: { 200: AdminRefreshModelCatalogResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      const gatewayMode = mode(dependencies);
      if (gatewayMode !== "openrouter") {
        return translateModelPolicyError(
          new ModelPolicyConflictError("Catalog refresh requires OpenRouter mode"),
        );
      }
      let claim: AdminCatalogRefreshClaim;
      try {
        claim = await dependencies.modelPolicy.claimAdminCatalogRefresh(
          actor.workspace.id,
          gatewayMode,
          dependencies.ownerIdFactory(),
          request.body.cursor,
        );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
      if (claim.modelIds.length === 0) {
        return reply.code(200).send({
          available: 0,
          claimed: 0,
          nextCursor: claim.nextCursor,
          unavailable: 0,
          updated: 0,
        });
      }
      try {
        const snapshots = await loadForRequest(
          request,
          reply,
          dependencies.loadCatalogSnapshots,
          claim.modelIds,
        );
        const result = await dependencies.modelPolicy.completeCatalogRefresh(claim, snapshots);
        return reply.code(200).send({
          ...result,
          claimed: claim.modelIds.length,
          nextCursor: claim.nextCursor,
        });
      } catch (error: unknown) {
        try {
          await dependencies.modelPolicy.releaseCatalogRefresh(claim);
        } catch {
          // A leaked lease remains bounded by its database expiry and is safe to retry later.
        }
        if (
          error instanceof ApplicationError ||
          error instanceof ModelPolicyConflictError ||
          error instanceof ModelPolicyUnavailableError
        ) {
          translateModelPolicyError(error);
        }
        throw validationFailure(503);
      }
    },
  );

  server.get(
    "/api/admin/model-policy",
    {
      schema: {
        response: { 200: AdminModelPolicyResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.modelPolicy.readAdminPolicy(actor.workspace.id, mode(dependencies)),
          );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
    },
  );

  server.put(
    "/api/admin/model-policy",
    {
      bodyLimit: 8_192,
      schema: {
        body: AdminUpdateModelPolicyRequestSchema,
        response: { 200: AdminUpdateModelPolicyResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.modelPolicy.replaceAdminPolicy(
              actor.workspace.id,
              mode(dependencies),
              actor,
              request.body,
            ),
          );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
    },
  );

  server.get(
    "/api/admin/model-policy/revisions",
    {
      schema: {
        querystring: AdminModelPolicyHistoryQuerySchema,
        response: { 200: AdminModelPolicyHistoryResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.modelPolicy.listAdminPolicyHistory(
              actor.workspace.id,
              mode(dependencies),
              request.query.cursor,
            ),
          );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
    },
  );

  server.post(
    "/api/admin/model-policy/revisions/:revision/revert",
    {
      bodyLimit: 2_048,
      schema: {
        body: AdminRevertModelPolicyRequestSchema,
        params: AdminModelPolicyRevisionParamsSchema,
        response: { 200: AdminModelPolicyResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.modelPolicy.revertAdminPolicy(
              actor.workspace.id,
              mode(dependencies),
              actor,
              request.params.revision,
              request.body.observedRevision,
            ),
          );
      } catch (error: unknown) {
        translateModelPolicyError(error);
      }
    },
  );
}
