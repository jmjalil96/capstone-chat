import type { ModelTierPolicyResponse } from "@capstone/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { DraftMemoryProvider } from "./draft-memory";
import { isModelTierAvailable, ModelTierPicker, useConversationModelTier } from "./model-tiers";

const conversationId = "11111111-1111-4111-8111-111111111111";
const queryScope = ["workspace-1", "employee-1", "2026-08-08T12:00:00.000Z"] as const;
const policy = {
  defaultTier: "balanced",
  tiers: [
    { tier: "fast", enabled: true, available: true },
    { tier: "balanced", enabled: true, available: true },
    { tier: "pro", enabled: true, available: false },
  ],
} satisfies ModelTierPolicyResponse;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ConversationTierHarness() {
  const tier = useConversationModelTier(conversationId);
  return (
    <ModelTierPicker
      error={tier.error}
      id="test-conversation"
      isPending={tier.isPending}
      onSelect={tier.select}
      policy={tier.policy}
      selectedTier={tier.selectedTier}
      updateError={tier.updateError}
      updatePending={tier.updatePending}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("model tier presentation", () => {
  it("shows only the three product tiers, disables unavailable choices, and persists selection", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/model-tiers") {
        return json(policy);
      }
      if (url.endsWith("/preferred-tier") && init?.method === "PUT") {
        return json({ conversationId, modelTier: "fast" });
      }
      if (url.endsWith("/preferred-tier")) {
        return json({ conversationId, modelTier: "balanced" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <DraftMemoryProvider queryScope={queryScope}>
            <ConversationTierHarness />
          </DraftMemoryProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const balanced = await screen.findByRole("radio", { name: /Balanced/ });
    await waitFor(() => expect(balanced).toBeChecked());
    expect(screen.getByRole("radio", { name: /Pro/ })).toBeDisabled();
    expect(screen.queryByText(/DeepSeek|Moonshot|OpenRouter/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Fast/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Fast/ })).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/preferred-tier`,
      expect.objectContaining({ body: JSON.stringify({ modelTier: "fast" }), method: "PUT" }),
    );
  });

  it("announces an unavailable persisted preference without substituting another tier", () => {
    render(
      <ModelTierPicker
        error={false}
        id="unavailable-conversation"
        isPending={false}
        onSelect={() => undefined}
        policy={policy}
        selectedTier="pro"
      />,
    );

    expect(screen.getByRole("radio", { name: /Pro/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Pro/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.modelTiers.unavailable);
    expect(isModelTierAvailable(policy, "pro")).toBe(false);
  });

  it("ignores a late preference response after its authenticated tree unmounts", async () => {
    let finishUpdate!: (response: Response) => void;
    const delayedUpdate = new Promise<Response>((resolve) => {
      finishUpdate = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/model-tiers") {
        return json(policy);
      }
      if (url.endsWith("/preferred-tier") && init?.method === "PUT") {
        return delayedUpdate;
      }
      if (url.endsWith("/preferred-tier")) {
        return json({ conversationId, modelTier: "balanced" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <DraftMemoryProvider queryScope={queryScope}>
            <ConversationTierHarness />
          </DraftMemoryProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("radio", { name: /Balanced/ })).toBeChecked());
    await user.click(screen.getByRole("radio", { name: /Fast/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/conversations/${conversationId}/preferred-tier`,
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    view.unmount();
    finishUpdate(json({ conversationId, modelTier: "fast" }));
    await delayedUpdate;
    await Promise.resolve();

    expect(
      queryClient.getQueryData(["conversations", ...queryScope, "preferred-tier", conversationId]),
    ).toBeUndefined();
  });
});
