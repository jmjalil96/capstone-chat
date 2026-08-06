import { type ReadinessResponse, ReadinessResponseSchema } from "@capstone/protocol";
import Value from "typebox/value";

const READINESS_ENDPOINT = "/api/health/ready";

export async function fetchReadiness(signal?: AbortSignal): Promise<ReadinessResponse> {
  const response = await fetch(READINESS_ENDPOINT, {
    headers: {
      accept: "application/json",
    },
    signal: signal ?? null,
  });

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new Error("The readiness response was not valid JSON.");
  }

  if (!Value.Check(ReadinessResponseSchema, payload)) {
    throw new Error("The readiness response did not match the protocol.");
  }

  if (
    (response.status === 200 && payload.status !== "ready") ||
    (response.status === 503 && payload.status !== "unavailable") ||
    (response.status !== 200 && response.status !== 503)
  ) {
    throw new Error("The readiness response used an unexpected HTTP status.");
  }

  return payload;
}
