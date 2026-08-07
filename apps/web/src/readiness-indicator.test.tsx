import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "./copy";
import { ReadinessIndicator } from "./readiness-indicator";

function response(payload: unknown, status: number): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
    status,
  } as unknown as Response;
}

function renderIndicator() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ReadinessIndicator />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReadinessIndicator", () => {
  it("announces loading", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => undefined)));

    renderIndicator();

    expect(screen.getByRole("status")).toHaveTextContent(copy.service.loading.status);
  });

  it("announces ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ status: "ready", database: "up" }, 200)),
    );

    renderIndicator();

    expect(await screen.findByText(copy.service.ready.status)).toBeVisible();
  });

  it("announces unavailable for an unavailable response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ status: "unavailable", database: "down" }, 503)),
    );

    renderIndicator();

    expect(await screen.findByText(copy.service.unavailable.status)).toBeVisible();
  });

  it("announces unavailable for a malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: "ready" }, 200)));

    renderIndicator();

    expect(await screen.findByText(copy.service.unavailable.status)).toBeVisible();
  });
});
