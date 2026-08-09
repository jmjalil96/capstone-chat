import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";
import { exerciseConversationControls } from "./support/phase5-controls-flow";
import {
  clipboardWrites,
  followConversationSidebarLink,
  installClipboardCapture,
  openAuthenticatedBrowserEmployee,
  openConversation,
  phaseFiveBrowserFixtures,
  rejectClipboardWrites,
  responseGalleryAssistantMarkdown,
  responseGalleryTypeScriptCode,
} from "./support/phase5-fixture";

test("@critical-stream renders the fixed response gallery safely and copies original source", async ({
  isMobile,
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const diagnostics: string[] = [];
  const requests: string[] = [];
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("pageerror", (error) => diagnostics.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  if (!isMobile) {
    await page.setViewportSize({ width: 1_280, height: 800 });
  }
  await installClipboardCapture(page);
  await openAuthenticatedBrowserEmployee(page, isMobile);
  await openConversation(page, phaseFiveBrowserFixtures.galleryTitle, isMobile);

  const galleryMessage = page
    .locator(".message-assistant")
    .filter({ hasText: "Encabezado de nivel uno" });
  const galleryContent = galleryMessage.locator("[data-message-content]");
  await expect(galleryMessage).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(
    galleryContent.getByRole("heading", { level: 2, name: "Encabezado de nivel uno" }),
  ).toBeVisible();
  await expect(
    galleryContent.getByRole("heading", { level: 3, name: "Encabezado de nivel dos" }),
  ).toBeVisible();
  await expect(
    galleryContent.getByRole("heading", { level: 4, name: "Encabezado de nivel tres" }),
  ).toBeVisible();
  await expect(
    galleryContent.getByRole("heading", { level: 5, name: "Encabezado de nivel cuatro" }),
  ).toBeVisible();
  await expect(
    galleryContent.getByRole("heading", { level: 6, name: "Encabezado de nivel cinco" }),
  ).toBeVisible();
  await expect(
    galleryContent.getByRole("heading", { level: 6, name: "Encabezado de nivel seis" }),
  ).toBeVisible();
  await expect(galleryContent.locator("table")).toHaveCount(2);
  await expect(galleryContent.locator("blockquote")).toHaveCount(1);
  await expect(galleryContent.locator('input[type="checkbox"]')).toHaveCount(2);
  expect(
    await galleryContent
      .locator('input[type="checkbox"]')
      .evaluateAll((inputs) => inputs.every((input) => (input as HTMLInputElement).disabled)),
  ).toBe(true);
  await expect(galleryContent.locator("pre")).toHaveCount(5);
  await expect(galleryContent.locator(".hljs-keyword").first()).toBeVisible();
  expect(await galleryContent.locator("math").count()).toBeGreaterThanOrEqual(3);

  const anchors = galleryContent.locator("a");
  await expect(anchors).toHaveCount(2);
  const anchorSafety = await anchors.evaluateAll((elements) =>
    elements.map((element) => ({
      href: (element as HTMLAnchorElement).href,
      rel: (element as HTMLAnchorElement).rel,
      target: (element as HTMLAnchorElement).target,
    })),
  );
  expect(anchorSafety).toEqual([
    {
      href: "https://example.com/seguro",
      rel: "noopener noreferrer",
      target: "_blank",
    },
    {
      href: "mailto:equipo@example.test",
      rel: "noopener noreferrer",
      target: "_blank",
    },
  ]);
  for (const label of ["destino de script", "destino de datos", "destino relativo", "fragmento"]) {
    await expect(galleryContent.getByText(label, { exact: true })).toBeVisible();
    await expect(galleryContent.getByRole("link", { name: label })).toHaveCount(0);
  }
  await expect(
    galleryContent.locator("img, script, iframe, object, embed, svg, style"),
  ).toHaveCount(0);
  await expect(galleryContent.locator("[style]")).toHaveCount(0);
  await expect(
    galleryContent.getByText("Imagen que no debe cargarse", { exact: true }),
  ).toBeVisible();
  expect(
    requests.some((url) =>
      ["media.invalid", "embed.invalid", "object.invalid"].some((host) => url.includes(host)),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as { __capstoneInjected?: string }).__capstoneInjected,
    ),
  ).toBeUndefined();

  const galleryUserMessage = page
    .locator(".message-user")
    .filter({ hasText: "Solicitud sintética" });
  const userCopy = galleryUserMessage.getByRole("button", {
    name: copy.conversations.messages.copyUser,
  });
  await userCopy.click();
  await expect(galleryUserMessage.locator(".message-actions .copy-action button")).toHaveText(
    copy.conversations.messages.copied,
  );
  expect((await clipboardWrites(page)).at(-1)).toBe(phaseFiveBrowserFixtures.galleryUser);

  const answerCopy = galleryMessage.getByRole("button", {
    name: copy.conversations.messages.copyAnswer,
  });
  await answerCopy.click();
  await expect(galleryMessage.locator(".message-actions .copy-action button")).toHaveText(
    copy.conversations.messages.copied,
  );
  expect((await clipboardWrites(page)).at(-1)).toBe(responseGalleryAssistantMarkdown);

  const codeCopy = galleryMessage
    .getByRole("button", { name: copy.conversations.messages.copyCode })
    .first();
  await codeCopy.click();
  await expect(
    galleryMessage.locator('[data-message-overflow="code"]').first().getByRole("button"),
  ).toHaveText(copy.conversations.messages.copied);
  expect((await clipboardWrites(page)).at(-1)).toBe(responseGalleryTypeScriptCode);

  await rejectClipboardWrites(page);
  const partialMessage = page
    .locator(".message-assistant")
    .filter({ hasText: phaseFiveBrowserFixtures.galleryPartial });
  const rejectedCopy = partialMessage.getByRole("button", {
    name: copy.conversations.messages.copyAnswer,
  });
  await rejectedCopy.focus();
  await rejectedCopy.press("Enter");
  await expect(partialMessage.getByRole("alert")).toHaveText(
    copy.conversations.messages.copyFailed,
  );
  await expect(rejectedCopy).toBeFocused();
  await expect(
    partialMessage.getByText(copy.conversations.generation.terminal.incomplete, { exact: true }),
  ).toBeVisible();
  await expect(partialMessage.getByText("1 / 2", { exact: true })).toBeVisible();

  if (testInfo.project.name === "chromium") {
    await galleryMessage
      .getByRole("heading", { level: 2, name: "Encabezado de nivel uno" })
      .scrollIntoViewIfNeeded();
    await testInfo.attach("galeria-formatos-escritorio", {
      body: await page.locator(".message-scroll").screenshot(),
      contentType: "image/png",
    });
  }

  if (!isMobile) {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await galleryMessage.locator('[data-message-overflow="table"]').last().scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const overflowGeometry = await galleryContent
    .locator("[data-message-overflow]")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })),
    );
  expect(overflowGeometry.some(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth)).toBe(
    true,
  );
  if (testInfo.project.name === "chromium") {
    await testInfo.attach("galeria-formatos-estrecha", {
      body: await page.locator(".message-scroll").screenshot(),
      contentType: "image/png",
    });
  }

  await test.step("preserves branch controls through reload and archive", () =>
    exerciseConversationControls(page, testInfo.project.name, isMobile));
  await test.step("opens a deep search result at its exact message once", () =>
    exerciseDeepSearchPositioning(page, isMobile));

  const diagnosticText = diagnostics.join("\n");
  for (const privateFixtureValue of [
    "Encabezado de nivel uno",
    "comandoQueNoExiste",
    "Solicitud sintética",
    "capstonecapstonecapstone",
    phaseFiveBrowserFixtures.controlsEditedRoot,
    phaseFiveBrowserFixtures.searchRootText,
  ]) {
    expect(diagnosticText).not.toContain(privateFixtureValue);
  }
});

async function exerciseDeepSearchPositioning(
  page: import("@playwright/test").Page,
  isMobile: boolean,
): Promise<void> {
  if (!isMobile) {
    await page.setViewportSize({ width: 1_280, height: 800 });
  }
  await followConversationSidebarLink(page, copy.conversations.navigation.search, isMobile);
  await page.getByLabel(copy.conversations.search.label).fill("ultravioleta");
  const result = page.getByRole("button", {
    name: new RegExp(phaseFiveBrowserFixtures.searchTitle),
  });
  await expect(result).toBeVisible();
  await page.evaluate(() => {
    const observed = window as unknown as {
      __capstoneSawSearchMatch?: boolean;
      __capstoneSearchMatchObserver?: MutationObserver;
    };
    observed.__capstoneSawSearchMatch = false;
    observed.__capstoneSearchMatchObserver?.disconnect();
    observed.__capstoneSearchMatchObserver = new MutationObserver(() => {
      if (document.querySelector(".message.search-match")) {
        observed.__capstoneSawSearchMatch = true;
      }
    });
    observed.__capstoneSearchMatchObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
  await result.click();

  await expect(
    page.getByRole("status").filter({ hasText: copy.conversations.search.located }),
  ).toHaveText(copy.conversations.search.located, { timeout: 10_000 });
  await expect(
    page.getByText(phaseFiveBrowserFixtures.searchRootText, { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __capstoneSawSearchMatch?: boolean }).__capstoneSawSearchMatch,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window.history.state as { usr?: unknown } | null)?.usr ?? null),
  ).toBeNull();

  await expect(page.locator(".message.search-match")).toHaveCount(0, { timeout: 3_500 });
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/u);
  await page.goForward();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/u);
  await expect(
    page.getByText(phaseFiveBrowserFixtures.searchRootText, { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.search-match")).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as {
        __capstoneSearchMatchObserver?: MutationObserver;
      }
    ).__capstoneSearchMatchObserver?.disconnect();
  });
}
