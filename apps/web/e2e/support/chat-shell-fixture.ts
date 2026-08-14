import type {
  ConversationMessage,
  ConversationSummary,
  GenerationModelTier,
} from "@capstone/protocol";
import type { Page, Route } from "@playwright/test";

import { availableModelTierPolicy } from "../../src/test/model-tier-fixture";
import { browserMessage, browserUuid } from "./streaming-fixture";

const now = "2026-08-14T12:00:00.000Z";
const secondPageCursor = "cursor.signature";

const fixtureSession = {
  employee: {
    id: "employee-chat-shell",
    name: "Empleada de Chat",
    email: "chat-shell@example.test",
  },
  workspace: {
    id: "workspace-chat-shell",
    identity: "capstone-chat-shell",
    name: "Capstone",
    role: "member",
  },
  session: {
    createdAt: now,
    expiresAt: "2026-08-21T12:00:00.000Z",
  },
} as const;

function summary(id: string, title: string | null, isArchived = false): ConversationSummary {
  return {
    id,
    title,
    isArchived,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export interface ChatShellFixture {
  readonly archivedId: string;
  readonly archivedTitle: string;
  readonly currentId: string;
  readonly currentTitle: string;
  readonly deepId: string;
  readonly deepTitle: string;
  readonly releaseCurrentDetail: () => void;
  readonly tierWrites: readonly GenerationModelTier[];
}

export async function installChatShellFixture(
  page: Page,
  options: { readonly holdCurrentDetail?: boolean } = {},
): Promise<ChatShellFixture> {
  const currentId = browserUuid(9_001);
  const sameTitleId = browserUuid(9_002);
  const recentId = browserUuid(9_003);
  const nullTitleId = browserUuid(9_004);
  const deepId = browserUuid(9_005);
  const archivedId = browserUuid(9_006);
  const currentUserId = browserUuid(9_099);
  const currentAssistantId = browserUuid(9_100);
  const deepLeafId = browserUuid(9_101);
  const currentTitle =
    "Conversación Café actual con seguimiento extraordinariamente detallado para el equipo regional";
  const deepTitle = "Proyecto fuera de la primera página";
  const archivedTitle = "Registro histórico archivado";
  const summaries = new Map<string, ConversationSummary>([
    [currentId, summary(currentId, currentTitle)],
    [sameTitleId, summary(sameTitleId, currentTitle)],
    [recentId, summary(recentId, "Seguimiento reciente")],
    [nullTitleId, summary(nullTitleId, null)],
    [deepId, summary(deepId, deepTitle)],
    [archivedId, summary(archivedId, archivedTitle, true)],
  ]);
  const messages = new Map<string, readonly ConversationMessage[]>([
    [
      currentId,
      [
        browserMessage({
          id: currentUserId,
          parentMessageId: null,
          role: "user",
          text: "Solicitud estable para revisar el shell.",
        }),
        browserMessage({
          id: currentAssistantId,
          parentMessageId: currentUserId,
          role: "assistant",
          text: "Respuesta estable para revisar el shell.",
        }),
      ],
    ],
    [
      deepId,
      (() => {
        // A long branch so the in-flow title genuinely scrolls out of view; the
        // focus-cue e2e coverage depends on that overflow being real.
        const branch = Array.from({ length: 22 }, (_, index) =>
          browserMessage({
            id: browserUuid(9_200 + index),
            parentMessageId: index === 0 ? null : browserUuid(9_200 + index - 1),
            role: index % 2 === 0 ? "user" : "assistant",
            text: `Intercambio previo número ${index + 1} para dar profundidad al historial.`,
          }),
        );
        return [
          ...branch,
          browserMessage({
            id: deepLeafId,
            parentMessageId: browserUuid(9_221),
            role: "user",
            text: "Resultado determinista abierto desde la búsqueda.",
          }),
        ];
      })(),
    ],
  ]);
  const drafts = new Map<string, { content: string; revision: number; updatedAt: string | null }>();
  const preferredTiers = new Map<string, GenerationModelTier>();
  const tierWrites: GenerationModelTier[] = [];
  let releaseCurrentDetail: () => void = () => undefined;
  const currentDetailGate = options.holdCurrentDetail
    ? new Promise<void>((resolve) => {
        releaseCurrentDetail = resolve;
      })
    : Promise.resolve();

  const requireSummary = (conversationId: string): ConversationSummary => {
    const conversation = summaries.get(conversationId);
    if (!conversation) {
      throw new Error(`Unknown chat-shell fixture conversation ${conversationId}`);
    }
    return conversation;
  };
  const revise = (
    conversationId: string,
    update: Partial<Pick<ConversationSummary, "isArchived" | "title">>,
  ): ConversationSummary => {
    const current = requireSummary(conversationId);
    const next = {
      ...current,
      ...update,
      revision: current.revision + 1,
      updatedAt: now,
    };
    summaries.set(conversationId, next);
    return next;
  };

  await page.route(/^http:\/\/127\.0\.0\.1:4173\/api\//u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/health/ready") {
      await json(route, { status: "ready", database: "up" });
      return;
    }
    if (url.pathname === "/api/session") {
      await json(route, fixtureSession);
      return;
    }
    if (url.pathname === "/api/model-tiers" && method === "GET") {
      await json(route, availableModelTierPolicy);
      return;
    }
    if (url.pathname === "/api/client-errors") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (url.pathname === "/api/drafts/new") {
      await json(route, {
        scope: { kind: "new" },
        content: "",
        revision: 0,
        updatedAt: null,
      });
      return;
    }
    if (url.pathname === "/api/conversations" && method === "GET") {
      const archived = url.searchParams.get("view") === "archived";
      if (archived) {
        await json(route, {
          conversations: [requireSummary(archivedId)],
          nextCursor: null,
        });
        return;
      }
      if (url.searchParams.get("cursor") === secondPageCursor) {
        await json(route, {
          conversations: [requireSummary(currentId), requireSummary(deepId)],
          nextCursor: null,
        });
        return;
      }
      await json(route, {
        conversations: [
          requireSummary(sameTitleId),
          requireSummary(recentId),
          requireSummary(nullTitleId),
        ].filter((conversation) => !conversation.isArchived),
        nextCursor: secondPageCursor,
      });
      return;
    }
    if (url.pathname === "/api/conversations/search" && method === "POST") {
      const conversation = requireSummary(deepId);
      await json(route, {
        results: [
          {
            conversation,
            leafMessageId: deepLeafId,
            matchedMessageId: null,
            matchKind: "title",
            snippet: [{ text: deepTitle, highlighted: true }],
          },
        ],
        nextCursor: null,
      });
      return;
    }

    const preferredTier = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f-]+)\/preferred-tier$/u,
    );
    if (preferredTier) {
      const conversationId = preferredTier[1];
      if (!conversationId || !summaries.has(conversationId)) {
        await json(route, { code: "NOT_FOUND", message: "Not found", requestId: "chat-tier" }, 404);
        return;
      }
      if (method === "PUT") {
        const body = request.postDataJSON() as { readonly modelTier: GenerationModelTier };
        preferredTiers.set(conversationId, body.modelTier);
        tierWrites.push(body.modelTier);
      }
      await json(route, {
        conversationId,
        modelTier: preferredTiers.get(conversationId) ?? "balanced",
      });
      return;
    }

    const action = url.pathname.match(
      /^\/api\/conversations\/([0-9a-f-]+)\/(archive|draft|response-states|selection|title|unarchive)$/u,
    );
    if (action) {
      const conversationId = action[1];
      const operation = action[2];
      if (!conversationId || !operation || !summaries.has(conversationId)) {
        await json(
          route,
          { code: "NOT_FOUND", message: "Not found", requestId: "chat-action" },
          404,
        );
        return;
      }
      if (operation === "draft") {
        const current = drafts.get(conversationId) ?? {
          content: "",
          revision: 0,
          updatedAt: null,
        };
        if (method === "PUT") {
          const body = request.postDataJSON() as { readonly content: string };
          const saved = {
            content: body.content,
            revision: current.revision + 1,
            updatedAt: now,
          };
          drafts.set(conversationId, saved);
          await json(route, { scope: { kind: "conversation", conversationId }, ...saved });
          return;
        }
        await json(route, { scope: { kind: "conversation", conversationId }, ...current });
        return;
      }
      if (operation === "response-states" && method === "POST") {
        await json(route, {
          conversationId,
          revision: requireSummary(conversationId).revision,
          responses: [],
        });
        return;
      }
      if (operation === "selection" && method === "PUT") {
        await json(route, {
          conversation: requireSummary(conversationId),
          selectedLeafId: deepLeafId,
        });
        return;
      }
      if (operation === "title" && method === "PATCH") {
        const body = request.postDataJSON() as { readonly title: string };
        await json(route, revise(conversationId, { title: body.title.normalize("NFC") }));
        return;
      }
      if (operation === "archive" && method === "POST") {
        await json(route, revise(conversationId, { isArchived: true }));
        return;
      }
      if (operation === "unarchive" && method === "POST") {
        await json(route, revise(conversationId, { isArchived: false }));
        return;
      }
    }

    const detail = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/u);
    if (detail) {
      const conversationId = detail[1];
      if (!conversationId || !summaries.has(conversationId)) {
        await json(
          route,
          { code: "NOT_FOUND", message: "Not found", requestId: "chat-detail" },
          404,
        );
        return;
      }
      if (method === "DELETE") {
        summaries.delete(conversationId);
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      if (conversationId === currentId) {
        await currentDetailGate;
      }
      const branch = messages.get(conversationId) ?? [];
      await json(route, {
        conversation: requireSummary(conversationId),
        selectedLeafId: branch.at(-1)?.id ?? null,
        messages: branch,
        nextCursor: null,
      });
      return;
    }

    await json(
      route,
      { code: "NOT_FOUND", message: "Not found", requestId: "chat-shell-fixture" },
      404,
    );
  });

  return {
    archivedId,
    archivedTitle,
    currentId,
    currentTitle,
    deepId,
    deepTitle,
    releaseCurrentDetail,
    tierWrites,
  };
}
