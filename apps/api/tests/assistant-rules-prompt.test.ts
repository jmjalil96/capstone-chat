import {
  ASSISTANT_RULES_MAX_CODE_POINTS,
  ASSISTANT_RULES_MAX_UTF8_BYTES,
} from "@capstone/protocol";
import { describe, expect, it } from "vitest";
import {
  assistantRulesCounts,
  composeAssistantSystemPrompt,
  createSystemPromptSnapshot,
  emptyWorkspaceAssistantRulesMarker,
  type InvalidAssistantRulesError,
  lockedAssistantBase,
  normalizeWorkspaceAssistantRules,
  workspaceAssistantHeading,
} from "../src/assistant-rules/prompt.js";

describe("workspace assistant-rule prompt", () => {
  it("normalizes Unicode, line endings, and outer whitespace without changing internal layout", () => {
    const normalized = normalizeWorkspaceAssistantRules(
      " \r\n Cafe\u0301\r\n\tRegla  interna\rFinal \r\n",
    );

    expect(normalized).toBe("Café\n\tRegla  interna\nFinal");
    expect(assistantRulesCounts(normalized)).toEqual({
      approximateInputTokens: Math.ceil(Buffer.byteLength(normalized, "utf8") / 4),
      codePoints: 26,
      utf8Bytes: 27,
    });
  });

  it("accepts the exact astral Unicode boundary and rejects malformed or oversized input", () => {
    const boundary = "😀".repeat(ASSISTANT_RULES_MAX_CODE_POINTS);
    expect(assistantRulesCounts(normalizeWorkspaceAssistantRules(boundary))).toEqual({
      approximateInputTokens: ASSISTANT_RULES_MAX_UTF8_BYTES / 4,
      codePoints: ASSISTANT_RULES_MAX_CODE_POINTS,
      utf8Bytes: ASSISTANT_RULES_MAX_UTF8_BYTES,
    });

    expect(() => normalizeWorkspaceAssistantRules(`${boundary}a`)).toThrowError(
      expect.objectContaining<Partial<InvalidAssistantRulesError>>({
        reason: "too_many_code_points",
      }),
    );
    expect(() => normalizeWorkspaceAssistantRules("regla\u0000privada")).toThrowError(
      expect.objectContaining<Partial<InvalidAssistantRulesError>>({
        reason: "unsupported_control",
      }),
    );
    expect(() => normalizeWorkspaceAssistantRules("\udc00")).toThrowError(
      expect.objectContaining<Partial<InvalidAssistantRulesError>>({
        reason: "invalid_unicode",
      }),
    );
  });

  it("places editable rules first and the locked base last, including the empty marker", () => {
    const composed = composeAssistantSystemPrompt("Regla editable");
    expect(composed).toBe(
      `${workspaceAssistantHeading}\n\nRegla editable\n\n${lockedAssistantBase.text}`,
    );
    expect(composeAssistantSystemPrompt("")).toBe(
      `${workspaceAssistantHeading}\n\n${emptyWorkspaceAssistantRulesMarker}\n\n${lockedAssistantBase.text}`,
    );
    expect(composed.indexOf("Regla editable")).toBeLessThan(
      composed.indexOf(lockedAssistantBase.text),
    );
  });

  it("captures a frozen revisioned prompt snapshot", () => {
    const snapshot = createSystemPromptSnapshot(7, "Regla");
    expect(snapshot).toMatchObject({
      baseVersion: "capstone-chat-base-v2",
      workspaceRevision: 7,
    });
    expect(snapshot.text.endsWith(lockedAssistantBase.text)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => createSystemPromptSnapshot(0, "Regla")).toThrow(
      "Workspace assistant prompt revision must be a positive integer",
    );
  });
});
