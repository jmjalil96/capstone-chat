import { type ClientErrorReport, ClientErrorReportSchema } from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApplicationError } from "../errors.js";
import type { ClientErrorRateLimiter } from "../observability/client-error-rate-limit.js";

export const CLIENT_ERROR_REPORT_BODY_LIMIT_BYTES = 1_024;

export interface AcceptedClientErrorReport extends Omit<ClientErrorReport, "release"> {
  readonly release: string;
}

export interface ClientErrorRouteDependencies {
  readonly isKnownAsset: (asset: string) => boolean;
  readonly onReport: (report: AcceptedClientErrorReport) => void;
  readonly rateLimiter: ClientErrorRateLimiter;
  readonly release: string;
  readonly resolveClientAddress?: ((request: FastifyRequest) => string) | undefined;
}

function normalizeReport(
  report: ClientErrorReport,
  dependencies: ClientErrorRouteDependencies,
): AcceptedClientErrorReport {
  if (report.asset !== undefined && !dependencies.isKnownAsset(report.asset)) {
    throw new ApplicationError(
      400,
      "BAD_REQUEST",
      "El informe de error contiene un recurso desconocido.",
    );
  }

  return Object.freeze({
    ...report,
    release: report.release === dependencies.release ? dependencies.release : "unknown",
  });
}

export function registerClientErrorRoute(
  fastify: FastifyInstance,
  dependencies: ClientErrorRouteDependencies,
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.post(
    "/api/client-errors",
    {
      bodyLimit: CLIENT_ERROR_REPORT_BODY_LIMIT_BYTES,
      schema: {
        body: ClientErrorReportSchema,
      },
    },
    async (request, reply) => {
      const clientAddress = dependencies.resolveClientAddress?.(request) ?? request.ip;
      if (!(await dependencies.rateLimiter.allow(clientAddress))) {
        return reply.code(204).send();
      }

      const report = normalizeReport(request.body, dependencies);
      try {
        dependencies.onReport(report);
      } catch {
        // Browser reporting is best-effort and cannot affect product availability.
      }
      request.log.warn(
        {
          ...(report.asset === undefined ? {} : { asset: report.asset }),
          ...(report.column === undefined ? {} : { column: report.column }),
          kind: report.kind,
          ...(report.line === undefined ? {} : { line: report.line }),
          release: report.release,
          route: report.route,
        },
        "client application failure reported",
      );
      return reply.code(204).send();
    },
  );
}
