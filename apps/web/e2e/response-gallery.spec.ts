import { expect, type Locator, type Page, test } from "@playwright/test";

import { copy } from "../src/copy";
import { exerciseConversationControls } from "./support/phase5-controls-flow";
import {
  clipboardCapturesFor,
  clipboardWrites,
  conversationRegion,
  followConversationSidebarLink,
  installClipboardCapture,
  openAuthenticatedBrowserEmployee,
  openConversation,
  phaseFiveBrowserFixtures,
  rejectClipboardWrites,
  responseGalleryAssistantMarkdown,
  responseGalleryTypeScriptCode,
} from "./support/phase5-fixture";

test("@critical-stream renders the fixed response gallery and hands off stable answers safely", async ({
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
  await expect(galleryContent.locator('input[type="checkbox"]')).toHaveCount(5);
  expect(
    await galleryContent
      .locator('input[type="checkbox"]')
      .evaluateAll((inputs) => inputs.every((input) => (input as HTMLInputElement).disabled)),
  ).toBe(true);
  await expect(galleryContent.locator("pre")).toHaveCount(5);
  await expect(galleryContent.locator(".hljs-keyword").first()).toBeVisible();
  expect(await galleryContent.locator("math").count()).toBeGreaterThanOrEqual(3);
  await expectGalleryLineEndings(galleryContent);
  await expectGalleryRhythm(galleryContent);
  await expectTaskLayout(galleryContent);
  await expectMessageContainment(galleryContent);

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
    galleryContent.getByText("Imagen que no debe cargarse\nen una segunda línea", { exact: true }),
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

  const handoffRequestCount = requests.length;
  const answerCopy = galleryMessage.getByRole("button", {
    name: copy.conversations.messages.copyAnswer,
  });
  await answerCopy.click();
  await expect(galleryMessage.locator('.answer-handoff-feedback[role="status"]')).toHaveText(
    copy.conversations.messages.copied,
  );
  const richAnswer = (await clipboardCapturesFor(page)).at(-1);
  expect(richAnswer?.text).toContain("Encabezado de nivel uno");
  expect(richAnswer?.text).toContain("Campo\tValor\nEstado\tEstable\nMotor\tLocal");
  expect(richAnswer?.text).not.toContain("# Encabezado");
  expect(richAnswer?.html).toContain("<h1>Encabezado de nivel uno</h1>");
  expect(richAnswer?.html).toContain('<a href="https://example.com/seguro">sitio seguro</a>');
  expect(richAnswer?.html).not.toMatch(/class=|target=|data-message|javascript:|<button/u);

  const exportButton = galleryMessage.getByRole("button", {
    name: copy.conversations.messages.export,
  });
  await exportButton.click();
  await galleryMessage
    .getByRole("button", { name: copy.conversations.messages.copyMarkdown })
    .click();
  expect((await clipboardWrites(page)).at(-1)).toBe(responseGalleryAssistantMarkdown);
  await expect(exportButton).toBeFocused();

  const tableCopy = galleryContent
    .getByRole("button", { name: copy.conversations.messages.copyTable })
    .first();
  await tableCopy.click();
  expect((await clipboardWrites(page)).at(-1)).toBe("Campo\tValor\nEstado\tEstable\nMotor\tLocal");

  await exportButton.click();
  const markdownDownloadPromise = page.waitForEvent("download");
  await galleryMessage
    .getByRole("button", { name: copy.conversations.messages.downloadMarkdown })
    .click();
  const markdownDownload = await markdownDownloadPromise;
  expect(markdownDownload.suggestedFilename()).toBe("respuesta-capstone-chat.md");
  const markdownStream = await markdownDownload.createReadStream();
  const markdownChunks: Buffer[] = [];
  for await (const chunk of markdownStream) markdownChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(markdownChunks).toString("utf8")).toBe(responseGalleryAssistantMarkdown);

  await exportButton.click();
  const textDownloadPromise = page.waitForEvent("download");
  await galleryMessage
    .getByRole("button", { name: copy.conversations.messages.downloadText })
    .click();
  const textDownload = await textDownloadPromise;
  expect(textDownload.suggestedFilename()).toBe("respuesta-capstone-chat.txt");
  const textStream = await textDownload.createReadStream();
  const textChunks: Buffer[] = [];
  for await (const chunk of textStream) textChunks.push(Buffer.from(chunk));
  const downloadedText = Buffer.concat(textChunks).toString("utf8");
  expect(downloadedText).toContain("Encabezado de nivel uno");
  expect(downloadedText).not.toContain("# Encabezado");

  await page.evaluate(() => {
    Object.defineProperty(window, "__capstonePrintSnapshot", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    window.print = () => {
      (
        window as unknown as {
          __capstonePrintSnapshot: string | undefined;
        }
      ).__capstonePrintSnapshot = document.querySelector(".answer-print-root")?.outerHTML;
    };
  });
  await exportButton.click();
  await galleryMessage
    .getByRole("button", { name: copy.conversations.messages.printAnswer })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __capstonePrintSnapshot: string | undefined;
            }
          ).__capstonePrintSnapshot,
      ),
    )
    .not.toBeUndefined();

  const capturedPrint = await page.evaluate(
    () =>
      (
        window as unknown as {
          __capstonePrintSnapshot: string | undefined;
        }
      ).__capstonePrintSnapshot,
  );
  expect(capturedPrint).toContain("Capstone Chat");
  expect(capturedPrint).toContain("Encabezado de nivel uno");
  expect(capturedPrint).not.toContain(phaseFiveBrowserFixtures.galleryTitle);
  expect(capturedPrint).not.toContain(phaseFiveBrowserFixtures.galleryUser);
  await page.emulateMedia({ media: "print" });
  expect(
    await page.evaluate(() => {
      const printRoot = document.querySelector<HTMLElement>(".answer-print-root");
      return {
        applicationHidden: [...document.body.children]
          .filter((child) => child !== printRoot)
          .every((child) => getComputedStyle(child).display === "none"),
        printDisplay: printRoot ? getComputedStyle(printRoot).display : undefined,
      };
    }),
  ).toEqual({ applicationHidden: true, printDisplay: "block" });
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator(".answer-print-root")).toHaveCount(0);
  expect(requests).toHaveLength(handoffRequestCount);

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
    copy.conversations.messages.copyFormattedFailed,
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
  await expectTaskLayout(galleryContent);
  await expectMessageContainment(galleryContent);
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

async function expectGalleryLineEndings(content: Locator): Promise<void> {
  for (const [first, second] of [
    ["formato en línea", "y continuación formateada"],
    ["Tarea con corte duro", "continuación de tarea"],
    ["Tarea anidada", "continuación anidada"],
    ["Una cita sintética para comprobar el formato", "con una segunda línea"],
    ["Imagen que no debe cargarse", "en una segunda línea"],
    ["Primera línea suave", "segunda línea suave"],
    ["Línea con corte duro", "continuación tras espacios"],
    ["Línea con corte por barra", "continuación tras barra"],
    ["Fuerte con corte duro", "continuación fuerte"],
  ] as const) {
    const { delta, lineHeight } = await textPairGeometry(content, first, second);
    expect(Math.abs(delta - lineHeight), `${first} must have exactly one line break`).toBeLessThan(
      2,
    );
  }
}

async function expectGalleryRhythm(content: Locator): Promise<void> {
  const geometry = await content.evaluate((root) => {
    const number = (value: string): number => Number.parseFloat(value) || 0;
    const textNode = (value: string): Text => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(value)) return node as Text;
      }
      throw new Error(`Missing response-gallery text: ${value}`);
    };
    const textLastLineTop = (value: string): number => {
      const node = textNode(value);
      const start = node.data.indexOf(value);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + value.length);
      const rect = [...range.getClientRects()].at(-1);
      if (!rect) throw new Error(`Response-gallery text has no line box: ${value}`);
      return rect.top;
    };
    const element = (value: string, selector: string): HTMLElement => {
      const found = textNode(value).parentElement?.closest<HTMLElement>(selector);
      if (!found) throw new Error(`Missing ${selector} for response-gallery text: ${value}`);
      return found;
    };
    const style = getComputedStyle(root);
    const rem = number(getComputedStyle(document.documentElement).fontSize);
    const space2 = number(style.getPropertyValue("--capstone-space-2")) * rem;
    const space3 = number(style.getPropertyValue("--capstone-space-3")) * rem;
    const space5 = number(style.getPropertyValue("--capstone-space-5")) * rem;
    const lineHeight = number(style.lineHeight);
    const firstHeading = element("Encabezado de nivel uno", "h2");
    const secondHeading = element("Encabezado de nivel dos", "h3");
    const nestedList = element("Elemento anidado", "ul");
    const plainNestedList = element("Subelemento simple", "ul");
    const quote = element("Una cita sintética", "blockquote");
    const quoteParagraph = quote.querySelector<HTMLElement>(":scope > p");
    const looseFirst = element("Tarea con párrafos", "p").getBoundingClientRect().bottom;
    const looseSecond = element("Segundo párrafo de la tarea", "p").getBoundingClientRect().top;
    const footnotes = root.querySelector<HTMLElement>("[data-footnotes]");
    const footnoteList = footnotes?.querySelector<HTMLElement>(":scope > ol");
    const actions = root
      .closest<HTMLElement>(".message")
      ?.querySelector<HTMLElement>(":scope > .message-actions");
    if (!quoteParagraph || !footnotes || !footnoteList || !actions)
      throw new Error("Missing response-gallery quote, footnote, or actions");

    return {
      footnoteActionsGap:
        actions.getBoundingClientRect().top - footnoteList.getBoundingClientRect().bottom,
      headingGap:
        secondHeading.getBoundingClientRect().top - firstHeading.getBoundingClientRect().bottom,
      looseGap: looseSecond - looseFirst,
      nestedGaps: [
        nestedList.getBoundingClientRect().top - textLastLineTop("y continuación formateada"),
        plainNestedList.getBoundingClientRect().top -
          textLastLineTop("Elemento simple sin formato"),
      ],
      quoteInset:
        quote.getBoundingClientRect().height - quoteParagraph.getBoundingClientRect().height,
      expected: { lineHeight, space2, space3, space5 },
    };
  });

  expect(Math.abs(geometry.headingGap - geometry.expected.space5)).toBeLessThan(2);
  for (const nestedGap of geometry.nestedGaps) {
    expect(
      Math.abs(nestedGap - (geometry.expected.lineHeight + geometry.expected.space2)),
    ).toBeLessThan(4);
  }
  expect(Math.abs(geometry.looseGap - geometry.expected.space2)).toBeLessThan(2);
  expect(Math.abs(geometry.quoteInset - 2 * geometry.expected.space2)).toBeLessThan(2);
  expect(Math.abs(geometry.footnoteActionsGap - geometry.expected.space3)).toBeLessThan(2);
}

async function expectTaskLayout(content: Locator): Promise<void> {
  const labels = ["Etiqueta de tarea extensa", "Tarea con párrafos", "Tarea anidada"];
  const geometries = await content.evaluate((root, taskLabels) => {
    const space2 =
      Number.parseFloat(getComputedStyle(root).getPropertyValue("--capstone-space-2")) *
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize);

    return taskLabels.map((label) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.includes(label)) node = walker.nextNode();
      const item = node?.parentElement?.closest<HTMLElement>(".task-list-item");
      const input = item?.querySelector<HTMLInputElement>("input[type='checkbox']");
      if (!(node instanceof Text) || !item || !input)
        throw new Error(`Missing task fixture: ${label}`);
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const firstLine = lines[0];
      const inputBox = input.getBoundingClientRect();
      const itemBox = item.getBoundingClientRect();
      if (!firstLine) throw new Error(`Task fixture has no rendered text: ${label}`);

      return {
        checkboxOnFirstLine:
          inputBox.top <= firstLine.bottom + 1 && inputBox.bottom >= firstLine.top - 1,
        contained: lines.every(
          (line) => line.left >= inputBox.right + space2 - 2 && line.right <= itemBox.right + 1,
        ),
        label,
        lineCount: lines.length,
      };
    });
  }, labels);

  for (const geometry of geometries) {
    expect(geometry.checkboxOnFirstLine, `${geometry.label} checkbox alignment`).toBe(true);
    expect(geometry.contained, `${geometry.label} continuation alignment`).toBe(true);
  }
  for (const label of labels.slice(0, 2)) {
    expect(geometries.find((geometry) => geometry.label === label)?.lineCount).toBeGreaterThan(1);
  }
}

async function textPairGeometry(
  content: Locator,
  first: string,
  second: string,
): Promise<{ delta: number; lineHeight: number }> {
  return content.evaluate(
    (root, values) => {
      const lineTop = (
        value: string,
        edge: "first" | "last",
      ): { lineHeight: number; top: number } => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.textContent?.indexOf(value) ?? -1;
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + value.length);
          if (!node.parentElement) throw new Error(`Detached response-gallery text: ${value}`);
          const rects = [...range.getClientRects()];
          const rect = edge === "first" ? rects[0] : rects.at(-1);
          if (!rect) throw new Error(`Response-gallery text has no line box: ${value}`);
          return {
            lineHeight: Number.parseFloat(getComputedStyle(node.parentElement).lineHeight),
            top: rect.top,
          };
        }
        throw new Error(`Missing response-gallery text: ${value}`);
      };
      const firstLine = lineTop(values.first, "last");
      return {
        delta: lineTop(values.second, "first").top - firstLine.top,
        lineHeight: firstLine.lineHeight,
      };
    },
    { first, second },
  );
}

async function expectMessageContainment(content: Locator): Promise<void> {
  const containment = await content.evaluate((root) => {
    const rootBox = root.getBoundingClientRect();
    const scroll = root.closest(".message-scroll");
    const scrollBox = scroll?.getBoundingClientRect();

    return {
      contentFitsOwnBox: root.scrollWidth <= root.clientWidth,
      documentFitsViewport:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      insideScrollArea: Boolean(
        scrollBox && rootBox.left >= scrollBox.left - 1 && rootBox.right <= scrollBox.right + 1,
      ),
    };
  });

  expect(containment).toEqual({
    contentFitsOwnBox: true,
    documentFitsViewport: true,
    insideScrollArea: true,
  });
}

async function exerciseDeepSearchPositioning(page: Page, isMobile: boolean): Promise<void> {
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
  await expect(conversationRegion(page, phaseFiveBrowserFixtures.searchTitle)).toBeFocused();
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
