import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONVERSATION_FOLLOW_THRESHOLD_PX } from "./config";
import {
  distanceFromBottom,
  useConversationScroll,
  wasNearBottomBeforeGrowth,
} from "./conversation-scroll";

interface ScrollHarnessProps {
  readonly contentReady?: boolean;
  readonly sentUserMessageId?: string;
  readonly streamActive?: boolean;
  readonly stream: { readonly messageId: string; readonly text: string } | undefined;
}

function ScrollHarness({
  contentReady = true,
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
  return (
    <>
      <div data-testid="scroll" ref={scroll.containerRef} onScroll={scroll.onScroll}>
        <div className="message-list">
          <p data-message-id="message-1">{stream?.text}</p>
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

  it("disengages for a document selection, exposes unseen state, and re-engages on Jump", () => {
    const view = render(
      <ScrollHarness stream={{ messageId: "message-1", text: "Primera parte" }} />,
    );
    const container = screen.getByTestId("scroll");
    const position = geometry(container);
    fireEvent.scroll(container);
    const selection = window.getSelection();
    const text = container.querySelector("p")?.firstChild;
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
    const text = container.querySelector("p")?.firstChild;
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
