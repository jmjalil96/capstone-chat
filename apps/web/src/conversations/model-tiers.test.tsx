import type { ModelTierPolicyResponse } from "@capstone/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

function triggerName(tier: "balanced" | "fast" | "pro"): string {
  return `${copy.conversations.modelTiers.label}: ${copy.conversations.modelTiers.tiers[tier].name}`;
}

function placeholderName(placeholder: "tierPending" | "tierUnknown"): string {
  return `${copy.conversations.modelTiers.label}: ${copy.conversations.modelTiers[placeholder]}`;
}

function openPopover(container: HTMLElement): HTMLElement {
  const popover = container.querySelector<HTMLElement>(".model-tier-popover");
  if (!popover) {
    throw new Error("The model tier popover is not open.");
  }
  return popover;
}

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
  it("keeps the trigger locked while policy loads and exposes a retryable load error", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ModelTierPicker
        error={false}
        id="loading-tiers"
        isPending
        onRetry={onRetry}
        onSelect={() => undefined}
        policy={undefined}
        selectedTier={undefined}
      />,
    );

    const trigger = screen.getByRole("button", { name: placeholderName("tierPending") });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector(".model-tier-popover")).toBeNull();
    const loadingStatus = screen.getByRole("status");
    expect(loadingStatus).toHaveTextContent(copy.conversations.modelTiers.loading);
    expect(trigger).toHaveAttribute("aria-describedby", loadingStatus.id);
    expect(
      screen.queryByText(copy.conversations.modelTiers.tiers.balanced.purpose),
    ).not.toBeInTheDocument();

    view.rerender(
      <ModelTierPicker
        error
        id="loading-tiers"
        isPending={false}
        onRetry={onRetry}
        onSelect={() => undefined}
        policy={undefined}
        selectedTier={undefined}
      />,
    );
    // A failed load must not keep announcing a loading placeholder.
    expect(screen.getByRole("button", { name: placeholderName("tierUnknown") })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(copy.conversations.modelTiers.loadError);
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows only the three product tiers with purposes in the popover and persists selection", async () => {
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
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <DraftMemoryProvider queryScope={queryScope}>
            <ConversationTierHarness />
          </DraftMemoryProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: triggerName("balanced") });
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-describedby"));
    expect(
      screen.queryByText(copy.conversations.modelTiers.tiers.balanced.purpose),
    ).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const popover = openPopover(container);
    const rows = within(popover).getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(within(popover).getByRole("button", { name: /^Fast/u })).toBeEnabled();
    const balancedRow = within(popover).getByRole("button", { name: /^Balanced/u });
    expect(balancedRow).toBeEnabled();
    expect(balancedRow).toHaveAttribute("aria-pressed", "true");
    expect(within(popover).getByRole("button", { name: /^Pro — No disponible/u })).toBeDisabled();
    for (const tier of ["fast", "balanced", "pro"] as const) {
      expect(
        within(popover).getByText(copy.conversations.modelTiers.tiers[tier].purpose),
      ).toBeVisible();
    }
    expect(screen.queryByText(/DeepSeek|Moonshot|OpenRouter/i)).not.toBeInTheDocument();

    await user.click(within(popover).getByRole("button", { name: /^Fast/u }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: triggerName("fast") })).toBeVisible(),
    );
    expect(container.querySelector(".model-tier-popover")).toBeNull();
    expect(
      screen.queryByText(copy.conversations.modelTiers.tiers.fast.purpose),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/preferred-tier`,
      expect.objectContaining({ body: JSON.stringify({ modelTier: "fast" }), method: "PUT" }),
    );
  });

  it("announces an unavailable persisted preference without substituting another tier", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModelTierPicker
        error={false}
        id="unavailable-conversation"
        isPending={false}
        onSelect={() => undefined}
        policy={policy}
        selectedTier="pro"
      />,
    );

    const trigger = screen.getByRole("button", { name: triggerName("pro") });
    expect(trigger).toBeEnabled();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(copy.conversations.modelTiers.unavailable);
    expect(trigger).toHaveAttribute("aria-describedby", status.id);
    expect(
      screen.queryByText(copy.conversations.modelTiers.tiers.pro.purpose),
    ).not.toBeInTheDocument();

    await user.click(trigger);
    const popover = openPopover(container);
    const proRow = within(popover).getByRole("button", { name: /^Pro — No disponible/u });
    expect(proRow).toBeDisabled();
    expect(proRow).toHaveAttribute("aria-pressed", "true");
    expect(isModelTierAvailable(policy, "pro")).toBe(false);
  });

  it("disables the trigger and explains when no tier is available", () => {
    const unavailablePolicy = {
      defaultTier: "balanced",
      tiers: [
        { ...policy.tiers[0], available: false },
        { ...policy.tiers[1], available: false },
        { ...policy.tiers[2], available: false },
      ],
    } satisfies ModelTierPolicyResponse;

    const { container } = render(
      <ModelTierPicker
        error={false}
        id="no-available-tiers"
        isPending={false}
        onSelect={() => undefined}
        policy={unavailablePolicy}
        selectedTier="balanced"
      />,
    );

    expect(screen.getByRole("button", { name: triggerName("balanced") })).toBeDisabled();
    expect(container.querySelector(".model-tier-popover")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      copy.conversations.modelTiers.noneAvailable,
    );
  });

  it("keeps the canonical selection and trigger focus after a save failure", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/model-tiers") {
        return json(policy);
      }
      if (url.endsWith("/preferred-tier") && init?.method === "PUT") {
        return json({ code: "INTERNAL_ERROR", message: "hidden", requestId: "request-1" }, 503);
      }
      if (url.endsWith("/preferred-tier")) {
        return json({ conversationId, modelTier: "balanced" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <DraftMemoryProvider queryScope={queryScope}>
            <ConversationTierHarness />
          </DraftMemoryProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: triggerName("balanced") });
    await user.click(trigger);
    await user.click(within(openPopover(container)).getByRole("button", { name: /^Fast/u }));

    const saveError = await screen.findByRole("alert");
    expect(saveError).toHaveTextContent(copy.conversations.modelTiers.saveError);
    expect(screen.getByRole("button", { name: triggerName("balanced") })).toBeVisible();
    await waitFor(() => expect(trigger).not.toHaveAttribute("aria-disabled"));
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAttribute("aria-describedby", saveError.id);
    expect(trigger).toHaveFocus();
    expect(container.querySelector(".model-tier-popover")).toBeNull();
    expect(
      screen.queryByText(copy.conversations.modelTiers.tiers.balanced.purpose),
    ).not.toBeInTheDocument();
  });

  it("keeps the focused trigger interactive but guarded while a save is pending", async () => {
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
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <DraftMemoryProvider queryScope={queryScope}>
            <ConversationTierHarness />
          </DraftMemoryProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: triggerName("balanced") });
    await user.click(trigger);
    await user.click(within(openPopover(container)).getByRole("button", { name: /^Fast/u }));

    await waitFor(() => expect(trigger).toHaveAttribute("aria-disabled", "true"));
    expect(trigger).toBeEnabled();
    expect(screen.getByRole("button", { name: triggerName("balanced") })).toBeVisible();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(container.querySelector(".model-tier-popover")).toBeNull();

    finishUpdate(json({ conversationId, modelTier: "fast" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: triggerName("fast") })).toBeVisible(),
    );
    expect(trigger).not.toHaveAttribute("aria-disabled");
    expect(trigger).toHaveFocus();
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

    const trigger = await screen.findByRole("button", { name: triggerName("balanced") });
    await user.click(trigger);
    await user.click(within(openPopover(view.container)).getByRole("button", { name: /^Fast/u }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/conversations/${conversationId}/preferred-tier`,
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    expect(screen.getByRole("button", { name: triggerName("balanced") })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    view.unmount();
    finishUpdate(json({ conversationId, modelTier: "fast" }));
    await delayedUpdate;
    await Promise.resolve();

    expect(
      queryClient.getQueryData(["conversations", ...queryScope, "preferred-tier", conversationId]),
    ).toBeUndefined();
  });

  it("closes on Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModelTierPicker
        error={false}
        id="escape-tiers"
        isPending={false}
        onSelect={() => undefined}
        policy={policy}
        selectedTier="balanced"
      />,
    );

    const trigger = screen.getByRole("button", { name: triggerName("balanced") });
    await user.click(trigger);
    expect(openPopover(container)).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(container.querySelector(".model-tier-popover")).toBeNull());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses on outside pointer input and only restores focus without a natural target", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <button type="button">Fuera</button>
        <p>Texto exterior</p>
        <ModelTierPicker
          error={false}
          id="outside-tiers"
          isPending={false}
          onSelect={() => undefined}
          policy={policy}
          selectedTier="balanced"
        />
      </>,
    );

    const trigger = screen.getByRole("button", { name: triggerName("balanced") });
    const outsideButton = screen.getByRole("button", { name: "Fuera" });
    await user.click(trigger);
    expect(openPopover(container)).toBeVisible();
    await user.click(outsideButton);
    await waitFor(() => expect(container.querySelector(".model-tier-popover")).toBeNull());
    expect(outsideButton).toHaveFocus();

    await user.click(trigger);
    expect(openPopover(container)).toBeVisible();
    await user.click(screen.getByText("Texto exterior"));
    await waitFor(() => expect(container.querySelector(".model-tier-popover")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("respects focus a dismissing click intentionally moved to a tabindex=-1 target", async () => {
    function IntentionalFocusHarness() {
      return (
        <>
          <button
            type="button"
            onClick={() => document.querySelector<HTMLElement>("#outside-alert")?.focus()}
          >
            Deshacer
          </button>
          <p id="outside-alert" role="alert" tabIndex={-1}>
            Alerta enfocada a propósito
          </p>
          <ModelTierPicker
            error={false}
            id="intent-tiers"
            isPending={false}
            onSelect={() => undefined}
            policy={policy}
            selectedTier="balanced"
          />
        </>
      );
    }
    const user = userEvent.setup();
    const { container } = render(<IntentionalFocusHarness />);

    const trigger = screen.getByRole("button", { name: triggerName("balanced") });
    await user.click(trigger);
    expect(openPopover(container)).toBeVisible();

    // The outside click closes the popover AND moves focus somewhere deliberate;
    // the dismissal fallback must not steal it back to the trigger.
    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(container.querySelector(".model-tier-popover")).toBeNull());
    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(alert).toHaveFocus();
  });

  it("keeps focus on the trigger when opening and reaches the first enabled option with Tab", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModelTierPicker
        error={false}
        id="tab-tiers"
        isPending={false}
        onSelect={() => undefined}
        policy={policy}
        selectedTier="balanced"
      />,
    );

    const trigger = screen.getByRole("button", { name: triggerName("balanced") });
    await user.click(trigger);
    const popover = openPopover(container);
    expect(trigger).toHaveFocus();
    await user.tab();
    expect(within(popover).getByRole("button", { name: /^Fast/u })).toHaveFocus();
  });

  it("closes the popover when focus moves outside without stealing focus back", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <ModelTierPicker
          error={false}
          id="focus-out-tiers"
          isPending={false}
          onSelect={() => undefined}
          policy={policy}
          selectedTier="balanced"
        />
        <button type="button">Después</button>
      </>,
    );

    const trigger = screen.getByRole("button", { name: triggerName("balanced") });
    const afterButton = screen.getByRole("button", { name: "Después" });
    await user.click(trigger);
    expect(openPopover(container)).toBeVisible();

    // Tab through the enabled options (Pro is disabled) and out of the disclosure.
    await user.tab();
    await user.tab();
    await user.tab();
    expect(afterButton).toHaveFocus();
    await waitFor(() => expect(container.querySelector(".model-tier-popover")).toBeNull());
    expect(afterButton).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the popover defensively when the trigger becomes locked", async () => {
    const user = userEvent.setup();
    const view = render(
      <ModelTierPicker
        error={false}
        id="defensive-tiers"
        isPending={false}
        onSelect={() => undefined}
        policy={policy}
        selectedTier="balanced"
      />,
    );

    await user.click(screen.getByRole("button", { name: triggerName("balanced") }));
    expect(openPopover(view.container)).toBeVisible();

    view.rerender(
      <ModelTierPicker
        error={false}
        id="defensive-tiers"
        isPending
        onSelect={() => undefined}
        policy={undefined}
        selectedTier={undefined}
      />,
    );
    await waitFor(() => expect(view.container.querySelector(".model-tier-popover")).toBeNull());
  });
});
