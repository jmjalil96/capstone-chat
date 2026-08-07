import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys } from "./api";
import { DraftEditor } from "./draft-editor";
import { DraftMemoryProvider, useDraftMemory } from "./draft-memory";

const queryScope = ["workspace-1", "employee-1", "2026-08-06T12:00:00.000Z"] as const;
const rotatedQueryScope = ["workspace-1", "employee-1", "2026-08-07T12:00:00.000Z"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function draft(content: string, revision: number) {
  return {
    scope: { kind: "new" },
    content,
    revision,
    updatedAt: revision === 0 ? null : "2026-08-06T12:00:00.000Z",
  } as const;
}

function FlushProbe({ capture }: { readonly capture: (flush: () => Promise<boolean>) => void }) {
  const { flushActiveDraft } = useDraftMemory();

  useEffect(() => capture(flushActiveDraft), [capture, flushActiveDraft]);
  return null;
}

function renderEditor(captureFlush?: (flush: () => Promise<boolean>) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftMemoryProvider queryScope={queryScope}>
        <DraftEditor scope={{ kind: "new" }} autoFocus />
        {captureFlush ? <FlushProbe capture={captureFlush} /> : null}
      </DraftMemoryProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("draft editor", () => {
  it("reflects typing immediately and saves once after the 600 ms pause", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("", 0)))
      .mockImplementationOnce(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body)) as { content: string };
        return json(draft(body.content, 1));
      });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await waitFor(() => expect(editor).toHaveFocus());

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Texto inmediato" } });
    expect(editor).toHaveValue("Texto inmediato");
    expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.unsaved);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(599);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      content: "Texto inmediato",
      observedRevision: 0,
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.saved),
    );
  });

  it("blocks autosave on a stale write and adopts the chosen server draft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("Original", 1)))
      .mockResolvedValueOnce(
        json(
          {
            code: "DRAFT_CHANGED",
            message: "Draft changed",
            requestId: "request-1",
          },
          409,
        ),
      )
      .mockResolvedValueOnce(json(draft("Otra pestaña", 2)));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toHaveValue("Original"));
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Versión local" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    expect(
      await screen.findByRole("heading", { name: copy.conversations.draft.conflictTitle }),
    ).toBeVisible();
    expect(editor).toHaveValue("Versión local");
    fireEvent.click(screen.getByRole("button", { name: copy.conversations.draft.keepServer }));
    expect(editor).toHaveValue("Otra pestaña");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("deliberately replaces a stale server draft against the newest revision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("Original", 1)))
      .mockResolvedValueOnce(
        json({ code: "DRAFT_CHANGED", message: "Draft changed", requestId: "request-2" }, 409),
      )
      .mockResolvedValueOnce(json(draft("Otra pestaña", 2)))
      .mockImplementationOnce(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body)) as {
          content: string;
          observedRevision: number;
        };
        expect(body).toEqual({ content: "Versión local", observedRevision: 2 });
        return json(draft(body.content, 3));
      });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toHaveValue("Original"));
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Versión local" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();
    await screen.findByRole("heading", { name: copy.conversations.draft.conflictTitle });

    fireEvent.click(screen.getByRole("button", { name: copy.conversations.draft.replaceServer }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(editor).toHaveValue("Versión local");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.saved),
    );
  });

  it("does not retry a failed save in the background without another edit or an explicit retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("", 0)))
      .mockResolvedValueOnce(
        json({ code: "INTERNAL_ERROR", message: "Unavailable", requestId: "request-3" }, 503),
      )
      .mockImplementationOnce(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body)) as { content: string };
        return json(draft(body.content, 1));
      });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Pendiente" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    vi.useRealTimers();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.unsaved);
    fireEvent.click(screen.getByRole("button", { name: copy.conversations.draft.retry }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.saved),
    );
  });

  it("adopts a newer server draft when a clean editor remounts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("Versión inicial", 1)))
      .mockResolvedValueOnce(json(draft("Actualizada en otra pestaña", 2)));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (visible: boolean) => (
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          {visible ? <DraftEditor scope={{ kind: "new" }} /> : null}
        </DraftMemoryProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toHaveValue("Versión inicial"));
    view.rerender(tree(false));
    view.rerender(tree(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: copy.conversations.draft.label })).toHaveValue(
        "Actualizada en otra pestaña",
      ),
    );
  });

  it("abandons an old draft request when the same employee's session generation rotates", async () => {
    let currentGeneration: "old" | "rotated" = "old";
    let finishOldSave: ((response: Response) => void) | undefined;
    let oldSaveSignal: AbortSignal | null | undefined;
    const writes: Array<{ content: string; observedRevision: number }> = [];
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        const body = JSON.parse(String(options.body)) as {
          content: string;
          observedRevision: number;
        };
        writes.push(body);
        if (writes.length === 1) {
          oldSaveSignal = options.signal;
          return new Promise<Response>((resolve) => {
            finishOldSave = resolve;
          });
        }
        return json(draft(body.content, body.observedRevision + 1));
      }
      return currentGeneration === "old"
        ? json(draft("Base de la sesión anterior", 8))
        : json(draft("Base de la sesión rotada", 0));
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (scope: typeof queryScope | typeof rotatedQueryScope) => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <DraftMemoryProvider queryScope={scope}>
            <DraftEditor scope={{ kind: "new" }} />
          </DraftMemoryProvider>
        </QueryClientProvider>
      </StrictMode>
    );
    const view = render(tree(queryScope));

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toHaveValue("Base de la sesión anterior"));
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Texto de la sesión anterior" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();
    await waitFor(() => expect(writes).toHaveLength(1));

    currentGeneration = "rotated";
    view.rerender(tree(rotatedQueryScope));
    await waitFor(() => expect(oldSaveSignal?.aborted).toBe(true));
    await waitFor(() => expect(editor).toHaveValue("Base de la sesión rotada"));

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Texto de la sesión rotada" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ content: "Texto de la sesión rotada", observedRevision: 0 });

    await act(async () => {
      finishOldSave?.(json(draft("Texto de la sesión anterior", 9)));
      await Promise.resolve();
    });

    const oldKey = conversationQueryKeys.draft(queryScope, { kind: "new" });
    const rotatedKey = conversationQueryKeys.draft(rotatedQueryScope, { kind: "new" });
    await waitFor(() => expect(queryClient.getQueryData(oldKey)).toBeUndefined());
    expect(queryClient.getQueryData(rotatedKey)).toMatchObject({
      content: "Texto de la sesión rotada",
      revision: 1,
    });
    expect(editor).toHaveValue("Texto de la sesión rotada");
    expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.saved);
  });

  it("keeps an initialized editor visible when a later canonical refetch fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("Texto conservado", 1)))
      .mockResolvedValueOnce(
        json({ code: "INTERNAL_ERROR", message: "Unavailable", requestId: "request-4" }, 503),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient } = renderEditor();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toHaveValue("Texto conservado"));
    await act(async () => {
      await queryClient.refetchQueries();
    });

    expect(editor).toBeVisible();
    expect(editor).toHaveValue("Texto conservado");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serializes simultaneous forced flushes and saves the newest coalesced edit", async () => {
    type PendingWrite = {
      readonly content: string;
      readonly observedRevision: number;
      readonly resolve: (response: Response) => void;
    };
    const pendingWrites: PendingWrite[] = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(draft("", 0)))
      .mockImplementation(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body)) as {
          content: string;
          observedRevision: number;
        };
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        return new Promise<Response>((resolve) => {
          pendingWrites.push({
            ...body,
            resolve: (response) => {
              activeWrites -= 1;
              resolve(response);
            },
          });
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    let flush: (() => Promise<boolean>) | undefined;
    renderEditor((activeFlush) => {
      flush = activeFlush;
    });

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await waitFor(() => expect(flush).toBeTypeOf("function"));
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Primera versión" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();
    await waitFor(() => expect(pendingWrites).toHaveLength(1));

    fireEvent.change(editor, { target: { value: "Versión más reciente" } });
    let firstFlush: Promise<boolean> | undefined;
    let secondFlush: Promise<boolean> | undefined;
    await act(async () => {
      firstFlush = flush?.();
      secondFlush = flush?.();
      await Promise.resolve();
    });
    expect(pendingWrites).toHaveLength(1);

    await act(async () => {
      pendingWrites[0]?.resolve(json(draft("Primera versión", 1)));
    });
    await waitFor(() => expect(pendingWrites).toHaveLength(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(pendingWrites).toHaveLength(2);
    expect(maximumActiveWrites).toBe(1);
    expect(pendingWrites[1]).toMatchObject({
      content: "Versión más reciente",
      observedRevision: 1,
    });

    let flushResults: readonly boolean[] = [];
    await act(async () => {
      pendingWrites[1]?.resolve(json(draft("Versión más reciente", 2)));
      flushResults = await Promise.all([firstFlush, secondFlush]).then((results) =>
        results.filter((result): result is boolean => result !== undefined),
      );
    });
    expect(flushResults).toEqual([true, true]);
    expect(maximumActiveWrites).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(editor).toHaveValue("Versión más reciente");
    expect(screen.getByRole("status")).toHaveTextContent(copy.conversations.draft.saved);
    expect(
      screen.queryByRole("heading", { name: copy.conversations.draft.conflictTitle }),
    ).not.toBeInTheDocument();
  });
});
