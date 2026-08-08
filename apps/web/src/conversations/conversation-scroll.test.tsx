import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode, type UIEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONVERSATION_FOLLOW_THRESHOLD_PX } from "./config";
import {
  distanceFromBottom,
  useConversationScroll,
  wasNearBottomBeforeGrowth,
} from "./conversation-scroll";
import { ConversationSelectionFence } from "./conversation-selection";

interface ScrollHarnessProps {
  readonly captureOnScroll?: (onScroll: (event: UIEvent<HTMLDivElement>) => void) => void;
  readonly contentReady?: boolean;
  readonly renderedContent?: ReactNode;
  readonly sentUserMessageId?: string;
  readonly streamActive?: boolean;
  readonly stream: { readonly messageId: string; readonly text: string } | undefined;
}

function ScrollHarness({
  captureOnScroll,
  contentReady = true,
  renderedContent,
  sentUserMessageId,
  stream,
  streamActive = stream !== undefined,
}: ScrollHarnessProps) {
  const scroll = useConversationScroll({
    contentReady,
    conversationId: "conversation-1",
    isFetchingNextPage: false,
    pageCount: 1,
    positionRequest: 0,
    presentedMessageCount: 1,
    sentUserMessageId,
    streamActive,
    streamPublication: stream,
  });
  captureOnScroll?.(scroll.onScroll);
  return (
    <>
      <div data-testid="scroll" ref={scroll.containerRef} onScroll={scroll.onScroll}>
        <ConversationSelectionFence
          containerRef={scroll.containerRef}
          onSelectionSnapshot={scroll.onSelectionSnapshot}
        />
        <div className="message-list">
          <p data-message-id="message-1">
            <span data-message-content="">{renderedContent ?? stream?.text}</span>
          </p>
        </div>
      </div>
      {scroll.unseen ? (
        <>
          <p>Contenido no visto</p>
          <button type="button" onClick={scroll.jumpToLatest}>
            Ir al final
          </button>
        </>
      ) : null}
    </>
  );
}

function geometry(element: HTMLElement, initialHeight = 1_000) {
  let height = initialHeight;
  let top = 700;
  const writes: number[] = [];
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => 250 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
        writes.push(value);
      },
    },
  });
  return {
    get top() {
      return top;
    },
    setHeight(value: number) {
      height = value;
    },
    setTop(value: number) {
      top = value;
    },
    writes,
  };
}

function firstContentText(container: HTMLElement): Text | undefined {
  const content = container.querySelector<HTMLElement>("[data-message-content]");
  return content
    ? ((document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode() as Text | null) ??
        undefined)
    : undefined;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation scroll geometry", () => {
  it("measures distance from the visible bottom without producing negative values", () => {
    expect(distanceFromBottom(1_000, 700, 250)).toBe(50);
    expect(distanceFromBottom(500, 400, 200)).toBe(0);
  });

  it("keeps following when one publication grows by more than the threshold", () => {
    const previousHeight = 1_000;
    const scrollTop = 700;
    const clientHeight = 250;
    const postGrowthHeight = 1_240;

    expect(wasNearBottomBeforeGrowth(previousHeight, scrollTop, clientHeight)).toBe(true);
    expect(distanceFromBottom(postGrowthHeight, scrollTop, clientHeight)).toBe(290);
  });

  it("does not follow when the employee was already away from the bottom", () => {
    expect(wasNearBottomBeforeGrowth(1_000, 500, 250)).toBe(false);
  });

  it("uses pre-growth geometry to follow one large frame and never moves on completion", () => {
    const view = render(<ScrollHarness stream={{ messageId: "message-1", text: "" }} />);
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    position.writes.length = 0;
    position.setHeight(1_240);

    view.rerender(<ScrollHarness stream={{ messageId: "message-1", text: "Respuesta grande" }} />);

    expect(position.writes).toEqual([1_240]);
    position.writes.length = 0;
    view.rerender(<ScrollHarness stream={undefined} />);
    expect(position.writes).toEqual([]);
  });

  it("waits for deferred message content before initial positioning", () => {
    const view = render(
      <ScrollHarness contentReady={false} stream={{ messageId: "assistant-1", text: "" }} />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container, 100);

    expect(position.writes).toEqual([]);
    position.setHeight(1_000);
    view.rerender(<ScrollHarness contentReady stream={undefined} />);

    expect(position.writes).toEqual([1_000]);
  });

  it("keeps an explicitly followed sent message inside the pre-growth threshold", () => {
    const view = render(<ScrollHarness contentReady={false} stream={undefined} />);
    const container = screen.getByTestId("scroll");
    const position = geometry(container, 1_000);
    position.setTop(600);
    Object.defineProperty(container.querySelector("[data-message-id]"), "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    view.rerender(
      <ScrollHarness
        contentReady
        sentUserMessageId="message-1"
        stream={{ messageId: "assistant-1", text: "" }}
      />,
    );

    expect(position.top).toBe(654);
    expect(distanceFromBottom(1_000, position.top, 250)).toBe(CONVERSATION_FOLLOW_THRESHOLD_PX);

    position.setHeight(1_042);
    view.rerender(
      <ScrollHarness
        contentReady
        sentUserMessageId="message-1"
        stream={{ messageId: "assistant-1", text: "" }}
      />,
    );
    expect(position.top).toBe(654);

    position.setHeight(1_084);
    view.rerender(
      <ScrollHarness
        contentReady
        sentUserMessageId="message-1"
        stream={{ messageId: "assistant-1", text: "Primer fragmento" }}
      />,
    );

    expect(position.top).toBe(1_084);
  });

  it("ignores a delayed trusted scroll from sent-message positioning", () => {
    let finishProgrammaticFrame: FrameRequestCallback | undefined;
    let onScroll: ((event: UIEvent<HTMLDivElement>) => void) | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        finishProgrammaticFrame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const view = render(
      <ScrollHarness
        captureOnScroll={(handler) => {
          onScroll = handler;
        }}
        contentReady={false}
        stream={undefined}
      />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container, 1_000);
    position.setTop(600);
    Object.defineProperty(container.querySelector("[data-message-id]"), "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    view.rerender(
      <ScrollHarness
        captureOnScroll={(handler) => {
          onScroll = handler;
        }}
        contentReady
        sentUserMessageId="message-1"
        stream={{ messageId: "assistant-1", text: "" }}
      />,
    );
    expect(position.top).toBe(654);
    act(() => finishProgrammaticFrame?.(0));
    position.setHeight(1_042);
    act(() =>
      onScroll?.({
        currentTarget: container,
        nativeEvent: { isTrusted: true },
      } as UIEvent<HTMLDivElement>),
    );

    position.writes.length = 0;
    position.setHeight(1_084);
    view.rerender(
      <ScrollHarness
        captureOnScroll={(handler) => {
          onScroll = handler;
        }}
        contentReady
        sentUserMessageId="message-1"
        stream={{ messageId: "assistant-1", text: "Primer fragmento" }}
      />,
    );

    expect(position.writes).toEqual([1_084]);
    expect(screen.queryByText("Contenido no visto")).not.toBeInTheDocument();
  });

  it("follows active same-source layout growth but not terminal reconciliation", () => {
    let notifyResize!: ResizeObserverCallback;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }

        observe() {}
        disconnect() {}
      },
    );
    const view = render(
      <ScrollHarness
        contentReady={false}
        stream={{ messageId: "assistant-1", text: "Respuesta" }}
      />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container, 1_000);
    view.rerender(
      <ScrollHarness contentReady stream={{ messageId: "assistant-1", text: "Respuesta" }} />,
    );
    position.setTop(700);
    position.writes.length = 0;
    position.setHeight(1_150);

    act(() => notifyResize([], {} as ResizeObserver));

    expect(position.writes).toEqual([1_150]);
    view.rerender(<ScrollHarness contentReady stream={undefined} streamActive={false} />);
    position.writes.length = 0;
    position.setHeight(1_250);
    act(() => notifyResize([], {} as ResizeObserver));

    expect(position.writes).toEqual([]);
  });

  it("does not follow observed layout growth while text is selected", () => {
    let notifyResize!: ResizeObserverCallback;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }

        observe() {}
        disconnect() {}
      },
    );
    const view = render(
      <ScrollHarness
        contentReady={false}
        stream={{ messageId: "assistant-1", text: "Respuesta" }}
      />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container, 1_000);
    view.rerender(
      <ScrollHarness contentReady stream={{ messageId: "assistant-1", text: "Respuesta" }} />,
    );
    const text = firstContentText(container);
    const selection = window.getSelection();
    expect(text).toBeDefined();
    expect(selection).not.toBeNull();
    const range = document.createRange();
    range.selectNodeContents(text as Node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    position.setTop(700);
    position.writes.length = 0;
    position.setHeight(1_150);

    act(() => notifyResize([], {} as ResizeObserver));

    expect(position.writes).toEqual([]);
  });

  it("disengages for a document selection, exposes unseen state, and re-engages on Jump", () => {
    const view = render(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte" }} />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    const selection = window.getSelection();
    const text = firstContentText(container);
    expect(selection).not.toBeNull();
    expect(text).toBeDefined();
    const range = document.createRange();
    range.selectNodeContents(text as Node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    position.setHeight(1_120);

    view.rerender(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte y más" }} />,
    );

    expect(screen.getByText("Contenido no visto")).toBeVisible();
    const scrollTo = vi.fn();
    Object.defineProperty(container, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.click(screen.getByRole("button", { name: "Ir al final" }));
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 1_120 });
    expect(screen.queryByText("Contenido no visto")).not.toBeInTheDocument();

    const selectedText = selection?.toString();
    expect(selectedText).not.toBe("");
    position.setTop(1_120);
    position.writes.length = 0;
    position.setHeight(1_240);
    view.rerender(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte y más contenido" }} />,
    );

    expect(position.writes).toEqual([1_240]);
    expect(screen.queryByText("Contenido no visto")).not.toBeInTheDocument();
    expect(selection?.toString()).toBe(selectedText);
  });

  it("preserves a live selection before publication when selectionchange has not fired", () => {
    const view = render(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte" }} />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    const text = firstContentText(container);
    const selection = window.getSelection();
    expect(text).toBeDefined();
    expect(selection).not.toBeNull();
    const range = document.createRange();
    range.setStart(text as Node, 0);
    range.setEnd(text as Node, 10);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selectedText = selection?.toString();
    expect(selectedText).not.toBe("");
    position.setHeight(1_120);

    view.rerender(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte y más" }} />,
    );

    expect(position.writes).toEqual([]);
    expect(screen.getByText("Contenido no visto")).toBeVisible();
    expect(selection?.toString()).toBe(selectedText);
  });

  it("relocates selected text when incremental Markdown removes rendered syntax", () => {
    const view = render(
      <ScrollHarness
        renderedContent="**Primer fragmento"
        stream={{ messageId: "message-1", text: "**Primer fragmento" }}
      />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    const text = firstContentText(container);
    const selection = window.getSelection();
    expect(text).toBeDefined();
    expect(selection).not.toBeNull();
    const range = document.createRange();
    range.setStart(text as Node, 2);
    range.setEnd(text as Node, 8);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("Primer");
    position.setHeight(1_120);

    view.rerender(
      <ScrollHarness
        renderedContent={
          <>
            <strong>Primer fragmento visible.</strong> Más texto.
          </>
        }
        stream={{
          messageId: "message-1",
          text: "**Primer fragmento visible.** Más texto.",
        }}
      />,
    );

    expect(selection?.toString()).toBe("Primer");
    expect(position.writes).toEqual([]);
    expect(screen.getByText("Contenido no visto")).toBeVisible();
  });

  it("fences canonical content replacement while no local publication exists", () => {
    const view = render(
      <ScrollHarness
        renderedContent={<span key="active">Salida canónica parcial.</span>}
        stream={undefined}
        streamActive
      />,
    );
    const container = screen.getByTestId("scroll");
    const text = firstContentText(container);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text as Node, 7);
    range.setEnd(text as Node, 15);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("canónica");

    view.rerender(
      <ScrollHarness
        renderedContent={<strong key="terminal">Salida canónica completa.</strong>}
        stream={undefined}
        streamActive={false}
      />,
    );

    expect(selection?.toString()).toBe("canónica");
  });

  it("keeps code selection rooted in code when terminal actions appear", () => {
    const code = "const answer = 42;";
    const view = render(
      <ScrollHarness
        renderedContent={
          <span data-message-selection-root="">
            <code>{code}</code>
          </span>
        }
        stream={{ messageId: "message-1", text: `\`\`\`ts\n${code}\n` }}
      />,
    );
    const container = screen.getByTestId("scroll");
    const text = container.querySelector("code")?.firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text as Node, 6);
    range.setEnd(text as Node, 12);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("answer");

    view.rerender(
      <ScrollHarness
        renderedContent={
          <>
            <button type="button">Copiar código</button>
            <span data-message-selection-root="">
              <code>{code}</code>
            </span>
          </>
        }
        stream={undefined}
        streamActive={false}
      />,
    );

    expect(selection?.toString()).toBe("answer");
  });

  it("restores a reparsed math selection to the visible MathML node", () => {
    const view = render(
      <ScrollHarness renderedContent="$x" stream={{ messageId: "message-1", text: "$x" }} />,
    );
    const container = screen.getByTestId("scroll");
    const text = firstContentText(container);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text as Node, 1);
    range.setEnd(text as Node, 2);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe("x");

    view.rerender(
      <ScrollHarness
        // The test DOM models KaTeX's MathML-only output, including its hidden source copy.
        renderedContent={createElement(
          "math",
          null,
          createElement(
            "semantics",
            null,
            createElement("mrow", null, createElement("mi", null, "x")),
            createElement(
              "annotation",
              { "data-message-selection-excluded": "", encoding: "application/x-tex" },
              "x",
            ),
          ),
        )}
        stream={{ messageId: "message-1", text: "$x$" }}
      />,
    );

    expect(selection?.toString()).toBe("x");
    expect(selection?.anchorNode?.parentElement?.localName).toBe("mi");
    expect(selection?.focusNode?.parentElement?.localName).toBe("mi");
  });

  it("does not disengage for a click-style selectstart with a collapsed selection", () => {
    const view = render(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte" }} />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    container
      .querySelector("p")
      ?.dispatchEvent(new Event("selectstart", { bubbles: true, cancelable: true }));
    position.setHeight(1_120);

    view.rerender(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte y más" }} />,
    );

    expect(position.writes).toEqual([1_120]);
    expect(screen.queryByText("Contenido no visto")).not.toBeInTheDocument();
  });

  it("uses non-animated Jump behavior when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const view = render(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte" }} />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    const selection = window.getSelection();
    const text = firstContentText(container);
    const range = document.createRange();
    range.selectNodeContents(text as Node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    position.setHeight(1_100);
    view.rerender(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte y más" }} />,
    );
    const scrollTo = vi.fn();
    Object.defineProperty(container, "scrollTo", { configurable: true, value: scrollTo });

    fireEvent.click(screen.getByRole("button", { name: "Ir al final" }));

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 1_100 });
  });
});
