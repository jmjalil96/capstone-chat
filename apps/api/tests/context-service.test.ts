import { describe, expect, it } from "vitest";
import { boundContextWindow, type ContextWindow } from "../src/generations/context-service.js";

const firstTurn = Object.freeze({
  assistant: Object.freeze({ id: "assistant-1", text: "🙂" }),
  user: Object.freeze({ id: "user-1", text: "á" }),
});
const secondTurn = Object.freeze({
  assistant: Object.freeze({ id: "assistant-2", text: "ñ" }),
  user: Object.freeze({ id: "user-2", text: "abc" }),
});
const previousCompaction = Object.freeze({
  id: "compaction-1",
  summary: "Resumen previo",
  throughMessageId: "assistant-0",
});

function contextWindow(sourceOverflow: boolean): ContextWindow {
  return Object.freeze({
    previousCompaction,
    recentTurns: Object.freeze([secondTurn]),
    sourceOverflow,
    sourceTurns: Object.freeze([firstTurn, secondTurn]),
  });
}

describe("context window byte re-bound", () => {
  it("uses the database's exact fixed overhead plus UTF-8 byte formula", () => {
    const bounded = boundContextWindow(contextWindow(false), 128 + 2 + 4);

    expect(bounded).toEqual({
      previousCompaction,
      recentTurns: [secondTurn],
      sourceOverflow: true,
      sourceTurns: [firstTurn],
    });
  });

  it("preserves compaction, recent turns, and a prior overflow signal", () => {
    const bounded = boundContextWindow(contextWindow(true), 1_000_000);

    expect(bounded).toEqual({
      previousCompaction,
      recentTurns: [secondTurn],
      sourceOverflow: true,
      sourceTurns: [firstTurn, secondTurn],
    });
  });
});
