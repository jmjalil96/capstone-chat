import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "./copy";
import { FoundationPage } from "./foundation-page";

function createResponse(payload: unknown, status = 200): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
    status,
  } as unknown as Response;
}

function renderFoundationPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <FoundationPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FoundationPage", () => {
  it("announces the loading state while readiness is pending", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => undefined)));

    renderFoundationPage();

    expect(
      screen.getByRole("heading", { level: 1, name: copy.foundation.loading.title }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(copy.foundation.loading.status);
  });

  it("renders the ready state for a valid ready response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createResponse({
          status: "ready",
          database: "up",
        }),
      ),
    );

    renderFoundationPage();

    expect(
      await screen.findByRole("heading", { level: 1, name: copy.foundation.ready.title }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(copy.foundation.ready.status);
  });

  it("renders the unavailable state for a valid unavailable response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createResponse(
          {
            status: "unavailable",
            database: "down",
          },
          503,
        ),
      ),
    );

    renderFoundationPage();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: copy.foundation.unavailable.title,
      }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(copy.foundation.unavailable.status);
  });

  it("renders the unavailable state when the response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createResponse({
          status: "ready",
          database: "maybe",
        }),
      ),
    );

    renderFoundationPage();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: copy.foundation.unavailable.title,
      }),
    ).toBeVisible();
  });

  it("exposes the brand, main content, and service status accessibly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createResponse({
          status: "ready",
          database: "up",
        }),
      ),
    );

    const { container } = renderFoundationPage();

    await screen.findByRole("heading", { level: 1, name: copy.foundation.ready.title });

    expect(screen.getByRole("link", { name: copy.brand.homeLabel })).toBeVisible();
    expect(screen.getByRole("main")).toBeVisible();
    expect(screen.getByRole("region", { name: copy.foundation.ready.title })).toBeVisible();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(container.querySelector(".brand-logo")).toHaveAttribute("alt", "");
  });
});
