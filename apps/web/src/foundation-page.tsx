import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
import { useQuery } from "@tanstack/react-query";

import { fetchReadiness } from "./api/readiness";
import { copy } from "./copy";

type FoundationState = "loading" | "ready" | "unavailable";

function getFoundationState(
  isPending: boolean,
  isError: boolean,
  readinessStatus?: "ready" | "unavailable",
): FoundationState {
  if (isPending) {
    return "loading";
  }

  if (isError || readinessStatus !== "ready") {
    return "unavailable";
  }

  return "ready";
}

export function FoundationPage() {
  const readiness = useQuery({
    queryKey: ["readiness"],
    queryFn: ({ signal }) => fetchReadiness(signal),
    refetchInterval: 5_000,
  });
  const state = getFoundationState(readiness.isPending, readiness.isError, readiness.data?.status);
  const stateCopy = copy.foundation[state];

  return (
    <div className="foundation-shell" data-state={state}>
      <header className="site-header">
        <a className="brand-link" href="/" aria-label={copy.brand.homeLabel}>
          <img className="brand-logo" src={capstoneLogo} alt="" />
        </a>
      </header>

      <main className="foundation-main">
        <section className="foundation-panel" aria-labelledby="foundation-title">
          <p className="foundation-eyebrow">{copy.foundation.eyebrow}</p>
          <h1 id="foundation-title">{stateCopy.title}</h1>
          <p className="foundation-description">{stateCopy.description}</p>
          <p className="foundation-status" role="status" aria-atomic="true" aria-live="polite">
            <span className="status-marker" aria-hidden="true" />
            <span>{stateCopy.status}</span>
          </p>
        </section>
      </main>
    </div>
  );
}
