import { expect, type Page, test } from "@playwright/test";

import { copy } from "../src/copy";
import { availableModelTierPolicy } from "../src/test/model-tier-fixture";
import { expectReviewedWcagState } from "./support/accessibility";
import {
  openAuthenticatedBrowserEmployee,
  openDesktopConversation,
  phaseFiveBrowserFixtures,
} from "./support/phase5-fixture";
import { browserUuid, installStreamingFixture } from "./support/streaming-fixture";

const now = "2026-08-08T12:00:00.000Z";
const adminSession = {
  employee: {
    id: "administrator-accessibility",
    name: "Administradora de Accesibilidad",
    email: "administrator.accessibility@example.test",
  },
  workspace: {
    id: "workspace-accessibility",
    identity: "capstone-accessibility",
    name: "Capstone",
    role: "admin",
  },
  session: {
    createdAt: now,
    expiresAt: "2026-08-15T12:00:00.000Z",
  },
} as const;

const catalogId = "11111111-1111-4111-8111-111111111111";
const capability = {
  temperatureSupported: true,
  reasoning: {
    kind: "optional",
    effortSupport: { kind: "all" },
    maxTokensAccepted: true,
    defaultEffort: null,
    defaultEnabled: null,
    traceSafety: "provider_excluded",
  },
} as const;
const catalog = {
  catalogId,
  modelId: "capstone/approved-model",
  displayName: "Modelo aprobado",
  available: true,
  contextLength: 131_072,
  maximumOutputTokens: 16_384,
  capability,
  validatedAt: now,
} as const;

async function installAdminFixture(page: Page): Promise<void> {
  await page.route(/^http:\/\/127\.0\.0\.1:4173\/api\//u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health/ready") {
      await route.fulfill({ json: { database: "up", status: "ready" } });
      return;
    }
    if (path === "/api/session") {
      await route.fulfill({ json: adminSession });
      return;
    }
    if (path === "/api/admin/employees") {
      await route.fulfill({
        json: {
          items: [
            {
              approvalId: "20000000-0000-4000-8000-000000000002",
              userId: "employee-accessibility",
              name: "Luis Pérez",
              email: "luis.accessibility@example.test",
              role: "member",
              status: "active",
              monthlySoftBudgetUsd: "25.000000000000000000",
            },
          ],
          nextCursor: null,
        },
      });
      return;
    }
    if (path === "/api/admin/model-catalog") {
      await route.fulfill({ json: { items: [catalog], nextCursor: null } });
      return;
    }
    if (path === "/api/admin/model-policy") {
      await route.fulfill({
        json: {
          revision: 1,
          currency: "USD",
          defaultTier: "balanced",
          monthlyBudgetUsd: "100.000000000000000000",
          actor: { kind: "system", label: "Sistema" },
          changeKind: "bootstrap",
          revertedFromRevision: null,
          updatedAt: now,
          tiers: (
            [
              ["fast", 4_096],
              ["balanced", 8_192],
              ["pro", 16_384],
            ] as const
          ).map(([tier, maximumOutputTokens]) => ({
            tier,
            catalogId,
            enabled: true,
            available: true,
            maximumOutputTokens,
            reasoningEffort: tier === "pro" ? "high" : "off",
            reasoningBudgetTokens: tier === "pro" ? 8_192 : 0,
            temperaturePreset: tier === "fast" ? "precise" : "balanced",
            temperatureStatus: { kind: "exact", reason: "supported" },
            effortStatus:
              tier === "pro"
                ? { kind: "translated", reason: "max_tokens_precision_unverified" }
                : { kind: "exact", reason: "reasoning_disabled" },
            budgetStatus:
              tier === "pro"
                ? { kind: "translated", reason: "max_tokens_precision_unverified" }
                : { kind: "exact", reason: "reasoning_disabled" },
            catalog: {
              modelId: catalog.modelId,
              displayName: catalog.displayName,
              available: catalog.available,
              contextLength: catalog.contextLength,
              maximumOutputTokens: catalog.maximumOutputTokens,
              capability,
              validatedAt: catalog.validatedAt,
            },
          })),
        },
      });
      return;
    }
    if (path === "/api/admin/model-policy/revisions") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
      return;
    }
    if (path === "/api/admin/assistant-rules") {
      await route.fulfill({
        json: {
          revision: 1,
          baseVersion: "capstone-chat-base-v2",
          baseText: "REGLAS BASE OBLIGATORIAS",
          workspaceText: "Usa USD para los ejemplos.",
          effectivePrompt:
            "CONTEXTO Y REGLAS DEL ESPACIO DE TRABAJO — EDITABLES\n\nUsa USD para los ejemplos.\n\nREGLAS BASE OBLIGATORIAS",
          actor: { kind: "system", label: "Sistema" },
          changeKind: "bootstrap",
          revertedFromRevision: null,
          updatedAt: now,
          limits: { maximumCodePoints: 3_200, maximumUtf8Bytes: 12_800 },
          disclosure: {
            visibleToActiveMembers: true,
            sentToConfiguredZdrProvider: true,
            retainedInImmutableHistory: true,
          },
          estimate: {
            counts: { codePoints: 26, utf8Bytes: 26, approximateInputTokens: 7 },
            balancedMaximumResponseCostPercent: "0.1",
          },
        },
      });
      return;
    }
    if (path === "/api/admin/assistant-rules/revisions") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
      return;
    }
    if (path === "/api/admin/assistant-rules/preview") {
      await route.fulfill({
        json: {
          normalizedWorkspaceText: "Usa USD para los ejemplos.",
          effectivePrompt:
            "CONTEXTO Y REGLAS DEL ESPACIO DE TRABAJO — EDITABLES\n\nUsa USD para los ejemplos.\n\nREGLAS BASE OBLIGATORIAS",
          estimate: {
            counts: { codePoints: 26, utf8Bytes: 26, approximateInputTokens: 7 },
            balancedMaximumResponseCostPercent: "0.1",
          },
        },
      });
      return;
    }
    if (path === "/api/admin/usage") {
      await route.fulfill({
        json: {
          period: {
            start: "2026-08-01T05:00:00.000Z",
            end: "2026-09-01T05:00:00.000Z",
            timezone: "America/Guayaquil",
          },
          budget: {
            monthlyBudgetUsd: "100.000000000000000000",
            actualCostUsd: "1.000000000000000000",
            estimatedCostUsd: "0.000000000000000000",
            reservedCostUsd: "0.000000000000000000",
            remainingUsd: "99.000000000000000000",
          },
          items: [],
          nextCursor: null,
        },
      });
      return;
    }
    if (path === "/api/admin/answer-reports") {
      await route.fulfill({
        json: {
          items: [
            {
              id: "30000000-0000-4000-8000-000000000003",
              reporter: { name: "Luis Accesible", email: "luis.accessibility@example.test" },
              reason: "outdated",
              note: "La cifra citada cambió.",
              createdAt: "2026-08-15T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      });
      return;
    }
    if (path === "/api/admin/answer-reports/30000000-0000-4000-8000-000000000003") {
      await route.fulfill({
        json: {
          id: "30000000-0000-4000-8000-000000000003",
          reporter: { name: "Luis Accesible", email: "luis.accessibility@example.test" },
          reason: "outdated",
          note: "La cifra citada cambió.",
          createdAt: "2026-08-15T12:00:00.000Z",
          exchange: { prompt: "¿Cuál es la prima?", answer: "La prima es 120 USD." },
        },
      });
      return;
    }
    if (path === "/api/client-errors") {
      await route.fulfill({ body: "", status: 204 });
      return;
    }
    await route.fulfill({
      json: { code: "NOT_FOUND", message: "Not found", requestId: "accessibility-fixture" },
      status: 404,
    });
  });
}

async function installMobileChatFixture(page: Page): Promise<void> {
  await page.route(/^http:\/\/127\.0\.0\.1:4173\/api\//u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/health/ready") {
      await route.fulfill({ json: { database: "up", status: "ready" } });
      return;
    }
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          ...adminSession,
          employee: { ...adminSession.employee, id: "member-accessibility" },
          workspace: { ...adminSession.workspace, role: "member" },
        },
      });
      return;
    }
    if (url.pathname === "/api/conversations" && request.method() === "GET") {
      await route.fulfill({ json: { conversations: [], nextCursor: null } });
      return;
    }
    if (url.pathname === "/api/drafts/new") {
      await route.fulfill({
        json: { scope: { kind: "new" }, content: "", revision: 0, updatedAt: null },
      });
      return;
    }
    if (url.pathname === "/api/model-tiers") {
      await route.fulfill({ json: availableModelTierPolicy });
      return;
    }
    if (url.pathname === "/api/assistant-rules") {
      await route.fulfill({
        json: {
          baseVersion: "capstone-chat-base-v2",
          baseText: "REGLAS BASE OBLIGATORIAS",
          workspaceText: "Usa USD para los ejemplos.",
          effectivePrompt:
            "CONTEXTO Y REGLAS DEL ESPACIO DE TRABAJO — EDITABLES\n\nUsa USD para los ejemplos.\n\nREGLAS BASE OBLIGATORIAS",
          updatedAt: now,
        },
      });
      return;
    }
    if (url.pathname === "/api/client-errors") {
      await route.fulfill({ body: "", status: 204 });
      return;
    }
    await route.fulfill({
      json: { code: "NOT_FOUND", message: "Not found", requestId: "mobile-a11y-fixture" },
      status: 404,
    });
  });
}

test("reviews a stable identity validation error with axe", async ({ page }, testInfo) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: copy.identity.signIn.title })).toBeVisible();
  await page.getByRole("button", { name: copy.identity.signIn.submit }).click();
  await expect(page.getByRole("alert")).toContainText(copy.identity.common.validationSummary);
  await expectReviewedWcagState(page, testInfo, "identity-validation-error");
});

test("reviews terminal and active response presentation at desktop and mobile sizes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await openAuthenticatedBrowserEmployee(page);
  await expectReviewedWcagState(page, testInfo, "authenticated-chat-desktop");

  await openDesktopConversation(page, phaseFiveBrowserFixtures.galleryTitle);
  await expectReviewedWcagState(page, testInfo, "terminal-response-gallery-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectReviewedWcagState(page, testInfo, "terminal-response-gallery-mobile");

  const streamingConversationId = browserUuid(8_000);
  await installStreamingFixture(page, [
    {
      id: streamingConversationId,
      title: "Respuesta activa accesible",
      streams: [
        {
          deltas: [{ delayMilliseconds: 80, text: "Respuesta parcial para revisar." }],
          outcome: "hold",
        },
      ],
    },
  ]);
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto(`/c/${streamingConversationId}`);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await draft.fill("Solicitud sintética para accesibilidad");
  await page.getByRole("button", { name: copy.conversations.generation.actions.send }).click();
  await expect(page.getByText("Respuesta parcial para revisar.", { exact: true })).toBeVisible();
  await expectReviewedWcagState(page, testInfo, "active-stream-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectReviewedWcagState(page, testInfo, "active-stream-mobile");
});

test("@critical-accessibility reviews all administration pages and their confirmation dialog at desktop and mobile sizes", async ({
  page,
}, testInfo) => {
  await installAdminFixture(page);
  for (const viewport of [
    { name: "desktop", width: 1_280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/admin/employees");
    await expect(
      page.getByRole("heading", { name: copy.administration.employees.title }),
    ).toBeVisible();
    await expect(
      page.getByRole("rowheader", { name: "luis.accessibility@example.test" }),
    ).toBeVisible();
    await expectReviewedWcagState(page, testInfo, `administration-employees-${viewport.name}`);
    await page
      .getByRole("button", { name: copy.administration.employees.deactivate })
      .press("Enter");
    await expect(
      page.getByRole("dialog", { name: copy.administration.employees.deactivateTitle }),
    ).toBeVisible();
    await expectReviewedWcagState(page, testInfo, `administration-confirmation-${viewport.name}`);
    await page.getByRole("button", { name: copy.administration.common.cancel }).click();

    await page.goto("/admin/assistant");
    await expect(
      page.getByRole("heading", { name: copy.administration.assistant.title }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: copy.administration.assistant.label }),
    ).toHaveValue("Usa USD para los ejemplos.");
    await expectReviewedWcagState(page, testInfo, `administration-assistant-${viewport.name}`);

    await page.goto("/admin/models");
    await expect(
      page.getByRole("heading", { name: copy.administration.models.title }),
    ).toBeVisible();
    await expect(page.getByText(catalog.modelId, { exact: true })).toBeVisible();
    await expectReviewedWcagState(page, testInfo, `administration-models-${viewport.name}`);

    await page.goto("/admin/usage");
    await expect(
      page.getByRole("heading", { name: copy.administration.usage.title }),
    ).toBeVisible();
    await expect(page.getByText(copy.administration.usage.empty, { exact: true })).toBeVisible();
    await expectReviewedWcagState(page, testInfo, `administration-usage-${viewport.name}`);

    await page.goto("/admin/reports");
    await expect(
      page.getByRole("heading", { name: copy.administration.reports.title }),
    ).toBeVisible();
    await expect(page.getByText("La cifra citada cambió.")).toBeVisible();
    await expectReviewedWcagState(page, testInfo, `administration-reports-${viewport.name}`);
    const reportTrigger = page.getByRole("button", { name: /Ver mensajes del reporte 1:/u });
    await reportTrigger.click();
    const reportDialog = page.getByRole("dialog", {
      name: copy.administration.reports.detailTitle,
    });
    await expect(reportDialog.getByText("La prima es 120 USD.", { exact: true })).toBeVisible();
    await expectReviewedWcagState(page, testInfo, `administration-report-detail-${viewport.name}`);
    await reportDialog.getByRole("button", { name: copy.administration.reports.close }).click();
    await expect(reportDialog).toBeHidden();
    await expect(reportTrigger).toBeFocused();
  }
});

test("@critical-accessibility scans the responsive authenticated shell", async ({
  page,
}, testInfo) => {
  await installMobileChatFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/account/assistant-rules");
  await expect(
    page.getByRole("heading", { name: copy.identity.assistantRules.title }),
  ).toBeVisible();
  await expectReviewedWcagState(page, testInfo, "member-assistant-rules-mobile");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: copy.conversations.newChat.title })).toBeVisible();
  const tierTrigger = page.getByRole("button", {
    name: new RegExp(`^${copy.conversations.modelTiers.label}:`, "u"),
  });
  await tierTrigger.click();
  await expect(page.locator(".model-tier-popover")).toBeVisible();
  await expectReviewedWcagState(page, testInfo, "open-model-tier-popover");
  await page.keyboard.press("Escape");
  await expect(page.locator(".model-tier-popover")).toHaveCount(0);
  await expect(tierTrigger).toBeFocused();
  const opener = page.getByRole("button", { name: copy.conversations.navigation.open });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: copy.conversations.navigation.label });
  await expect(drawer).toBeVisible();
  await expectReviewedWcagState(page, testInfo, "open-mobile-chat-drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();
});
