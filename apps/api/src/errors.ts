import { type ApiError, ApiErrorSchema } from "@capstone/protocol";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const errorCopy = {
  badRequest: "La solicitud no es válida.",
  internal: "Ocurrió un error interno.",
  notFound: "No se encontró el recurso solicitado.",
} as const;

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
    const statusCode = error.validation === undefined ? (error.statusCode ?? 500) : 400;
    const isClientError = statusCode >= 400 && statusCode < 500;

    logError(request, error, statusCode, isClientError);

    sendErrorEnvelope(reply, statusCode, {
      code: isClientError ? "BAD_REQUEST" : "INTERNAL_ERROR",
      message: isClientError ? errorCopy.badRequest : errorCopy.internal,
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
