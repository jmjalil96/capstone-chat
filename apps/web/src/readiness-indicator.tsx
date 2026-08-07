import { useQuery } from "@tanstack/react-query";

import { fetchReadiness } from "./api/readiness";
import { copy } from "./copy";

type ServiceState = "loading" | "ready" | "unavailable";

export function ReadinessIndicator() {
  const readiness = useQuery({
    queryKey: ["readiness"],
    queryFn: ({ signal }) => fetchReadiness(signal),
    refetchInterval: 5_000,
  });
  const state: ServiceState = readiness.isPending
    ? "loading"
    : readiness.isError || readiness.data?.status !== "ready"
      ? "unavailable"
      : "ready";

  return (
    <p className="service-status" data-state={state} role="status" aria-live="polite">
      <span className="status-marker" aria-hidden="true" />
      <span>{copy.service[state].status}</span>
    </p>
  );
}
