import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AdminAssistantRulesResponseSchema,
  AssistantRulesHistoryResponseSchema,
  MemberAssistantRulesResponseSchema,
  PreviewAssistantRulesRequestSchema,
  UpdateAssistantRulesRequestSchema,
} from "../src/index.js";

const actor = {
  displayName: "Andrea Pérez",
  kind: "user",
  userId: "better-auth-user-1",
} as const;
const response = {
  actor,
  baseText: "Base",
  baseVersion: "capstone-chat-base-v2",
  changeKind: "save",
  disclosure: {
    retainedInImmutableHistory: true,
    sentToConfiguredZdrProvider: true,
    visibleToActiveMembers: true,
  },
  effectivePrompt: "Editable\n\nBase",
  estimate: {
    balancedMaximumResponseCostPercent: "0.25",
    counts: {
      approximateInputTokens: 4,
      codePoints: 12,
      utf8Bytes: 14,
    },
  },
  limits: {
    maximumCodePoints: 3_200,
    maximumUtf8Bytes: 12_800,
  },
  revertedFromRevision: null,
  revision: 2,
  updatedAt: "2026-08-17T15:00:00.000Z",
  workspaceText: "Sea directo.",
} as const;

describe("assistant-rules contracts", () => {
  it("accepts the complete admin and member projections", () => {
    expect(Value.Check(AdminAssistantRulesResponseSchema, response)).toBe(true);
    expect(
      Value.Check(MemberAssistantRulesResponseSchema, {
        baseText: response.baseText,
        baseVersion: response.baseVersion,
        effectivePrompt: response.effectivePrompt,
        updatedAt: response.updatedAt,
        workspaceText: response.workspaceText,
      }),
    ).toBe(true);
  });

  it("keeps request and response objects closed", () => {
    expect(
      Value.Check(PreviewAssistantRulesRequestSchema, {
        workspaceText: "Texto",
        actor,
      }),
    ).toBe(false);
    expect(
      Value.Check(UpdateAssistantRulesRequestSchema, {
        observedRevision: 2,
        workspaceText: "Texto",
        revision: 3,
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminAssistantRulesResponseSchema, {
        ...response,
        hiddenActorEmail: "admin@example.com",
      }),
    ).toBe(false);
  });

  it("accepts newest-first history with a system actor", () => {
    expect(
      Value.Check(AssistantRulesHistoryResponseSchema, {
        items: [
          {
            actor,
            changeKind: "save",
            createdAt: response.updatedAt,
            revertedFromRevision: null,
            revision: 2,
            workspaceText: "Sea directo.",
          },
          {
            actor: { kind: "system", label: "Sistema" },
            changeKind: "bootstrap",
            createdAt: "2026-08-17T14:00:00.000Z",
            revertedFromRevision: null,
            revision: 1,
            workspaceText: "Predeterminado",
          },
        ],
        nextCursor: null,
      }),
    ).toBe(true);
  });
});
