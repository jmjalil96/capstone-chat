import { type ApiError, type ApiErrorCode, ApiErrorSchema } from "@capstone/protocol";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const errorCopy = {
  badRequest: "La solicitud no es válida.",
  internal: "Ocurrió un error interno.",
  notFound: "No se encontró el recurso solicitado.",
  payloadTooLarge: "El contenido supera el tamaño permitido.",
} as const;

export class ApplicationError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(statusCode: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sendErrorEnvelope(reply: FastifyReply, statusCode: number, error: ApiError): void {
  const serializer = reply.compileSerializationSchema(
    ApiErrorSchema as unknown as Record<string, unknown>,
  );
  void reply.code(statusCode).serializer(serializer).send(error);
}

export function registerErrorHandling(fastify: FastifyInstance): void {
  fastify.setNotFoundHandler((request, reply) => {
    sendErrorEnvelope(reply, 404, {
      code: "NOT_FOUND",
      message: errorCopy.notFound,
      requestId: request.id,
    });
  });

  fastify.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ApplicationError) {
      logError(request, error, error.statusCode, true);
      sendErrorEnvelope(reply, error.statusCode, {
        code: error.code,
        message: error.message,
        requestId: request.id,
      });
      return;
    }

    const payloadTooLarge =
      error.statusCode === 413 ||
      error.validation?.some(
        (issue) => issue.keyword === "~refine" && issue.params.message === "PAYLOAD_TOO_LARGE",
      );
    const statusCode = payloadTooLarge
      ? 413
      : error.validation === undefined
        ? (error.statusCode ?? 500)
        : 400;
    const isClientError = statusCode >= 400 && statusCode < 500;

    logError(request, error, statusCode, isClientError);

    sendErrorEnvelope(reply, statusCode, {
      code: payloadTooLarge
        ? "PAYLOAD_TOO_LARGE"
        : isClientError
          ? "BAD_REQUEST"
          : "INTERNAL_ERROR",
      message: payloadTooLarge
        ? errorCopy.payloadTooLarge
        : isClientError
          ? errorCopy.badRequest
          : errorCopy.internal,
      requestId: request.id,
    });
  });
}

function logError(
  request: FastifyRequest,
  error: FastifyError,
  statusCode: number,
  isClientError: boolean,
): void {
  const metadata = {
    errorCode: error.code,
    errorName: error.name,
    requestId: request.id,
    statusCode,
  };

  if (isClientError) {
    request.log.info(metadata, "request rejected");
    return;
  }

  request.log.error(metadata, "request failed");
}
