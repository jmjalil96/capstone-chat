import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";
import { availableModelTierPolicy } from "../src/test/model-tier-fixture";

const session = {
  employee: {
    id: "employee-1",
    name: "Ana Pérez",
    email: "ana@example.test",
  },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "admin",
  },
  session: {
    createdAt: "2026-08-06T12:00:00.000Z",
    expiresAt: "2026-08-13T12:00:00.000Z",
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/health/ready", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ready", database: "up" }),
    });
  });
  await page.route("**/api/model-tiers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(availableModelTierPolicy),
    });
  });
});

test("renders the responsive Spanish sign-in form accessibly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      }),
    });
  });
  await page.goto("/sign-in");

  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page).toHaveTitle(copy.brand.pageTitle(copy.identity.signIn.title));
  const brandLink = page.getByRole("link", { name: copy.brand.homeLabel });
  const heading = page.getByRole("heading", { level: 1, name: copy.identity.signIn.title });
  const email = page.getByLabel(copy.identity.common.emailLabel);
  const forgotPassword = page.getByRole("link", { name: copy.identity.signIn.forgotPassword });
  const password = page.getByLabel(copy.identity.common.passwordLabel);
  await expect(brandLink).toBeVisible();
  await expect(brandLink).toHaveCSS("transition-duration", "0s");
  await expect(heading).toBeFocused();
  await expect(email).toHaveAttribute("autocomplete", "username");
  await expect(email).toHaveCSS("border-color", "rgb(91, 107, 116)");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(page.getByRole("status")).toContainText(copy.service.ready.status);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await email.fill("ana@example.test");
  await page.keyboard.press("Tab");
  await expect(forgotPassword).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await password.fill("abcdefghijkl");
  await password.press("Enter");
  await expect(page.getByRole("alert")).toBeFocused();
});

test("redirects an anonymous protected route without rendering protected data", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required",
        requestId: "request-1",
      }),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
  ).toBeVisible();
  await expect(page.getByText(session.employee.email)).toHaveCount(0);
});

test("renders the authenticated conversation shell for an active member", async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
  await page.route("**/api/conversations?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversations: [], nextCursor: null }),
    });
  });
  await page.route("**/api/drafts/new", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scope: { kind: "new" },
        content: "",
        revision: 0,
        updatedAt: null,
      }),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: copy.conversations.newChat.title,
    }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: copy.conversations.draft.label })).toBeFocused();
  await expect(
    page.getByRole("link", { name: copy.conversations.navigation.search }),
  ).toBeVisible();
});

test("@critical-identity moves an open authenticated app to sign-in when a draft save is revoked", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
  await page.route("**/api/conversations?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversations: [], nextCursor: null }),
    });
  });
  await page.route("**/api/drafts/new", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication required",
          requestId: "request-revoked-draft",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scope: { kind: "new" },
        content: "",
        revision: 0,
        updatedAt: null,
      }),
    });
  });

  await page.goto("/");
  await page
    .getByRole("textbox", { name: copy.conversations.draft.label })
    .fill("Este borrador pertenece a la sesión revocada.");

  await expect(page).toHaveURL(/\/sign-in$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
  ).toBeVisible();
  await expect(page.getByText(session.employee.email)).toHaveCount(0);
});

test("uses a modal mobile drawer and restores focus to its opener", async ({ page }) => {
  const maximumTitle = "T".repeat(120);
  const maximumSnippet = "S".repeat(162);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
  await page.route("**/api/conversations?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversations: [], nextCursor: null }),
    });
  });
  await page.route("**/api/drafts/new", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scope: { kind: "new" },
        content: "",
        revision: 0,
        updatedAt: null,
      }),
    });
  });
  await page.route("**/api/conversations/search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            conversation: {
              id: "11111111-1111-4111-8111-111111111111",
              title: maximumTitle,
              isArchived: true,
              revision: 0,
              createdAt: "2026-08-06T12:00:00.000Z",
              updatedAt: "2026-08-06T12:00:00.000Z",
            },
            leafMessageId: "22222222-2222-4222-8222-222222222222",
            matchedMessageId: "22222222-2222-4222-8222-222222222222",
            matchKind: "message",
            snippet: [{ text: maximumSnippet, highlighted: true }],
          },
        ],
        nextCursor: null,
      }),
    });
  });

  await page.goto("/");
  const opener = page.getByRole("button", { name: copy.conversations.navigation.open });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: copy.conversations.navigation.label });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: copy.conversations.common.newChat })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();
  await expect(page.locator(".conversation-shell")).toHaveCSS("transition-duration", "0s");
  expect(
    await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    }),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.goto("/search");
  await page.getByLabel(copy.conversations.search.label).fill("S");
  await expect(page.getByText(maximumSnippet)).toBeVisible();
  const searchMetrics = await page.locator(".search-page").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(searchMetrics.scrollWidth).toBeLessThanOrEqual(searchMetrics.clientWidth);

  await page.setViewportSize({ width: 844, height: 320 });
  await page.goto("/");
  const shortDraft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(shortDraft).toBeFocused();
  const shortDraftBox = await shortDraft.boundingBox();
  const shortMainBox = await page.locator(".conversation-main").boundingBox();
  expect(shortDraftBox).not.toBeNull();
  expect(shortMainBox).not.toBeNull();
  expect((shortDraftBox?.y ?? 0) + (shortDraftBox?.height ?? 0)).toBeLessThanOrEqual(
    (shortMainBox?.y ?? 0) + (shortMainBox?.height ?? 0) + 1,
  );
});

test("resets selected-branch scrolling when the conversation route parameter changes", async ({
  page,
}) => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const emptyId = "44444444-4444-4444-8444-444444444444";
  const summary = (id: string, title: string) => ({
    id,
    title,
    isArchived: false,
    revision: 0,
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  });
  const summaries = [
    summary(firstId, "Conversación uno"),
    summary(secondId, "Conversación dos"),
    summary(emptyId, "Conversación vacía"),
  ];
  const messages = (prefix: string) =>
    Array.from({ length: 30 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-3333-4333-8333-${prefix}${String(index + 1).padStart(8, "0")}`,
      parentMessageId: null,
      role: index % 2 === 0 ? "user" : "assistant",
      content: [
        {
          type: "text",
          text: `${prefix} mensaje ${index + 1}\nContenido suficiente para desplazar la rama seleccionada.`,
        },
      ],
      createdAt: "2026-08-06T12:00:00.000Z",
      siblingCount: 0,
    }));
  const branches = new Map([
    [firstId, messages("1111")],
    [secondId, messages("2222")],
  ]);
  let secondInitialRequests = 0;
  let secondCursorRequests = 0;
  let failCanonicalRecovery = false;
  let submittedTitle: string | undefined;

  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
  await page.route("**/api/conversations?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversations: summaries, nextCursor: null }),
    });
  });
  await page.route("**/api/conversations/**", async (route) => {
    const url = new URL(route.request().url());
    const conversationId = url.pathname.split("/")[3] ?? "";
    const conversation = summaries.find((item) => item.id === conversationId);
    if (!conversation) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    if (url.pathname.endsWith("/preferred-tier")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversationId, modelTier: "balanced" }),
      });
      return;
    }
    if (url.pathname.endsWith("/draft")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/response-states")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId,
          revision: conversation.revision,
          responses: [],
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/title") && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { title: string };
      submittedTitle = body.title;
      const canonical = {
        ...conversation,
        title: body.title.normalize("NFC").replace(/\s+/gu, " ").trim(),
        revision: conversation.revision + 1,
      };
      Object.assign(conversation, canonical);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(canonical),
      });
      return;
    }
    if (conversationId === secondId && url.searchParams.has("cursor")) {
      secondCursorRequests += 1;
      if (secondCursorRequests === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "INTERNAL_ERROR",
            message: "Pagination failed",
            requestId: "request-pagination",
          }),
        });
        return;
      }
      failCanonicalRecovery = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "CONVERSATION_CHANGED",
          message: "Conversation changed",
          requestId: "request-cursor",
        }),
      });
      return;
    }
    if (conversationId === secondId) {
      secondInitialRequests += 1;
      if (failCanonicalRecovery) {
        failCanonicalRecovery = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "INTERNAL_ERROR",
            message: "Canonical recovery failed",
            requestId: "request-recovery",
          }),
        });
        return;
      }
    }
    const branch = branches.get(conversationId) ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation,
        selectedLeafId: branch.at(-1)?.id ?? null,
        messages: branch,
        nextCursor: conversationId === secondId ? "cursor.signature" : null,
      }),
    });
  });

  await page.goto(`/c/${firstId}`);
  const scroll = page.locator(".message-scroll");
  await expect(page.getByText("1111 mensaje 30")).toBeVisible();
  await expect(page.getByRole("article", { name: "Conversación uno" })).toBeFocused();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.locator(".desktop-sidebar").getByRole("link", { name: "Conversación dos" }).click();
  await expect(page.getByText("2222 mensaje 30")).toBeVisible();
  await expect(page.getByRole("article", { name: "Conversación dos" })).toBeFocused();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const dockDraft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  const dockDraftBox = await dockDraft.boundingBox();
  expect(dockDraftBox).not.toBeNull();
  expect((dockDraftBox?.y ?? 0) + (dockDraftBox?.height ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.height ?? 0,
  );
  const olderButton = page.getByRole("button", {
    name: copy.conversations.conversation.older,
  });
  await olderButton.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByText("2222 mensaje 30")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Conversación dos" })).toBeVisible();
  await expect(page).toHaveTitle(/Conversación dos/u);
  const conversationError = page
    .getByRole("alert")
    .filter({ hasText: copy.conversations.common.genericError });
  await expect(conversationError).toBeVisible();
  await olderButton.evaluate((element) => {
    const container = element.closest<HTMLElement>(".message-scroll");
    if (!container) {
      throw new Error("The pagination control has no message scroll container");
    }
    container.scrollTop = 0;
    (element as HTMLButtonElement).click();
  });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => secondInitialRequests).toBeGreaterThanOrEqual(2);
  await expect(conversationError).toBeVisible();
  await conversationError.getByRole("button", { name: copy.conversations.common.retry }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: copy.conversations.common.changed }),
  ).toBeVisible();
  await expect.poll(() => secondInitialRequests).toBeGreaterThanOrEqual(3);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const actionTrigger = page.getByRole("button", {
    name: copy.conversations.conversation.actionsLabel("Conversación dos"),
  });
  await actionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.rename }).click();
  const renameDialog = page.getByRole("dialog", {
    name: copy.conversations.conversation.renameTitle,
  });
  const decomposedTitle = "e\u0301".repeat(120);
  const canonicalTitle = "é".repeat(120);
  await renameDialog
    .getByRole("textbox", { name: copy.conversations.conversation.titleLabel, exact: true })
    .fill(decomposedTitle);
  const saveTitle = renameDialog.getByRole("button", {
    name: copy.conversations.conversation.saveTitle,
  });
  await expect(saveTitle).toBeEnabled();
  await saveTitle.click();
  expect(submittedTitle).toBe(decomposedTitle);
  await expect(page.getByRole("heading", { level: 1, name: canonicalTitle })).toBeVisible();

  const canonicalActionTrigger = page.getByRole("button", {
    name: copy.conversations.conversation.actionsLabel(canonicalTitle),
  });
  await canonicalActionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.rename }).click();
  await renameDialog
    .getByRole("textbox", { name: copy.conversations.conversation.titleLabel, exact: true })
    .fill("Nombre\u2028inválido");
  await expect(
    renameDialog.getByRole("button", { name: copy.conversations.conversation.saveTitle }),
  ).toBeDisabled();
  await renameDialog.getByRole("button", { name: copy.conversations.conversation.cancel }).click();
  await expect(canonicalActionTrigger).toBeFocused();

  await page.setViewportSize({ width: 844, height: 320 });
  await page.goto(`/c/${emptyId}`);
  const emptyDraft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(page.getByRole("article", { name: "Conversación vacía" })).toBeFocused();
  const emptyDraftBox = await emptyDraft.boundingBox();
  const emptyMainBox = await page.locator(".conversation-main").boundingBox();
  expect(emptyDraftBox).not.toBeNull();
  expect(emptyMainBox).not.toBeNull();
  expect((emptyDraftBox?.y ?? 0) + (emptyDraftBox?.height ?? 0)).toBeLessThanOrEqual(
    (emptyMainBox?.y ?? 0) + (emptyMainBox?.height ?? 0) + 1,
  );
});

test("removes a password-reset token fragment from the visible URL before input", async ({
  page,
}) => {
  await page.goto("/reset-password#token=browser-secret");

  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.resetPassword.title }),
  ).toBeVisible();
  await expect(page.getByLabel(copy.identity.common.newPasswordLabel)).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await expect(page.locator("body")).not.toContainText("browser-secret");
});
