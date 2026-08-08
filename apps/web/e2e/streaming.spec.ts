import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";
import { browserMessage, browserUuid, installStreamingFixture } from "./support/streaming-fixture";

const navigationFirstId = browserUuid(1);
const navigationSecondId = browserUuid(2);

test("@critical-stream keeps conversation streams isolated across navigation and stops one safely", async ({
  page,
}) => {
  const diagnostics: string[] = [];
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("pageerror", (error) => diagnostics.push(error.message));
  const fixture = await installStreamingFixture(page, [
    {
      id: navigationFirstId,
      title: "Conversación Alfa",
      streams: [
        {
          deltas: [
            { delayMilliseconds: 180, text: "Respuesta alfa " },
            { delayMilliseconds: 260, text: "completa." },
          ],
          outcome: "completed",
        },
      ],
    },
    {
      id: navigationSecondId,
      title: "Conversación Beta",
      streams: [
        {
          deltas: [{ delayMilliseconds: 100, text: "Respuesta beta parcial." }],
          outcome: "hold",
        },
      ],
    },
  ]);

  await page.goto(`/c/${navigationFirstId}`);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await draft.fill("Solicitud alfa");
  await expect(page.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await draft.press("Enter");
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.stop }),
  ).toBeVisible();

  const sidebar = page.locator(".desktop-sidebar");
  await sidebar.getByRole("link", { name: "Conversación Beta" }).click();
  await expect(page).toHaveURL(`/c/${navigationSecondId}`);
  await draft.fill("Solicitud beta");
  await page.getByRole("button", { name: copy.conversations.generation.actions.send }).click();
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.stop }),
  ).toBeVisible();

  await sidebar.getByRole("link", { name: "Conversación Alfa" }).click();
  await expect(page.getByText("Respuesta alfa completa.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.send }),
  ).toBeVisible();

  await sidebar.getByRole("link", { name: "Conversación Beta" }).click();
  await expect(page.getByText("Respuesta beta parcial.", { exact: true })).toBeVisible();
  await draft.fill("Borrador beta conservado.");
  await expect(page.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: copy.conversations.generation.actions.stop }).click();
  await expect(
    page
      .locator(".response-outcome")
      .filter({ hasText: copy.conversations.generation.terminal.cancelled }),
  ).toBeVisible();
  await expect(draft).toHaveValue("Borrador beta conservado.");

  expect(fixture.starts.map(({ conversationId }) => conversationId)).toEqual([
    navigationFirstId,
    navigationSecondId,
  ]);
  expect(fixture.cancellations).toHaveLength(1);
  expect(fixture.cancellations[0]?.conversationId).toBe(navigationSecondId);
  const capturedDiagnostics = diagnostics.join("\n");
  for (const privateValue of [
    "Solicitud alfa",
    "Borrador beta conservado.",
    "Respuesta alfa completa.",
    "Continúa desde donde te detuviste",
    '"type":"response.started"',
    '"type":"content.delta"',
  ]) {
    expect(capturedDiagnostics).not.toContain(privateValue);
  }
});

test("@critical-stream follows growth, respects manual scrolling, and jumps to the latest output", async ({
  page,
}) => {
  const conversationId = browserUuid(60);
  const priorMessages = Array.from({ length: 10 }, (_, index) => {
    const userId = browserUuid(61 + index * 2);
    const assistantId = browserUuid(62 + index * 2);
    const parentMessageId = index === 0 ? null : browserUuid(60 + index * 2);
    return [
      browserMessage({
        id: userId,
        parentMessageId,
        role: "user",
        text: `Pregunta histórica ${index + 1}`,
      }),
      browserMessage({
        id: assistantId,
        parentMessageId: userId,
        role: "assistant",
        text: `Respuesta histórica ${index + 1} con suficiente contenido para ocupar espacio.`,
      }),
    ];
  }).flat();
  const priorSelectedLeafId = priorMessages.at(-1)?.id;
  if (!priorSelectedLeafId) {
    throw new Error("The streaming geometry fixture needs a selected leaf");
  }
  const fixture = await installStreamingFixture(page, [
    {
      id: conversationId,
      title: "Posición estable",
      revision: 10,
      selectedLeafId: priorSelectedLeafId,
      messages: priorMessages,
      streams: [
        {
          deltas: [
            { delayMilliseconds: 80, text: "Primer fragmento visible." },
            {
              delayMilliseconds: 1_500,
              text: `\n${Array.from(
                { length: 20 },
                (_, index) => `Línea de crecimiento ${index + 1}.`,
              ).join("\n")}\n\n**Selección estable`,
            },
            {
              delayMilliseconds: 2_000,
              text: ` confirmada.**\n${Array.from(
                { length: 12 },
                (_, index) => `Contenido no visto ${index + 1}.`,
              ).join("\n")}`,
            },
            {
              delayMilliseconds: 2_500,
              text: "\nFragmento seguido después del salto.",
            },
            {
              delayMilliseconds: 700,
              text: "\nCierre final seguido.",
            },
          ],
          outcome: "completed",
        },
      ],
    },
  ]);

  await page.setViewportSize({ width: 1_280, height: 760 });
  await page.goto(`/c/${conversationId}`);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await draft.fill("Pregunta recién enviada");
  await expect(page.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: copy.conversations.generation.actions.send }).click();
  await expect.poll(() => fixture.starts.length).toBe(1);

  const storedMessages = fixture.conversation(conversationId).messages;
  const sentUserId = storedMessages.at(-2)?.id;
  const sentAssistantId = storedMessages.at(-1)?.id;
  expect(sentUserId).toBeTruthy();
  expect(sentAssistantId).toBeTruthy();
  const sentUser = page.locator(`[data-message-id="${sentUserId}"]`);
  const sentAssistant = page.locator(`[data-message-id="${sentAssistantId}"]`);
  const streamedContent = sentAssistant.locator("[data-message-content]");
  await expect(sentUser).toContainText("Pregunta recién enviada");
  await expect(sentAssistant).toContainText("Primer fragmento visible.");
  const scroll = page.locator(".message-scroll");
  await expect
    .poll(() =>
      scroll.evaluate(
        (container) => container.scrollHeight - container.scrollTop - container.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(96);

  const presentedIds = await page
    .locator(".message")
    .evaluateAll((messages) =>
      messages.map((message) => (message as HTMLElement).dataset.messageId),
    );
  expect(presentedIds.slice(-2)).toEqual([sentUserId, sentAssistantId]);
  const initialGeometry = await page.locator(".message-scroll").evaluate(
    (container, ids) => {
      const sent = container.querySelector<HTMLElement>(`[data-message-id="${ids.user}"]`);
      const assistant = container.querySelector<HTMLElement>(
        `[data-message-id="${ids.assistant}"]`,
      );
      if (!sent || !assistant) {
        throw new Error("The streamed turn was not presented");
      }
      const viewport = container.getBoundingClientRect();
      const user = sent.getBoundingClientRect();
      return {
        assistantTop: assistant.getBoundingClientRect().top,
        distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
        scrollTop: container.scrollTop,
        userBottom: user.bottom,
        userTop: user.top,
        viewportBottom: viewport.bottom,
        viewportTop: viewport.top,
      };
    },
    { assistant: sentAssistantId, user: sentUserId },
  );
  expect(initialGeometry.userTop).toBeGreaterThanOrEqual(initialGeometry.viewportTop);
  expect(initialGeometry.userTop).toBeLessThan(initialGeometry.viewportBottom);
  expect(initialGeometry.assistantTop).toBeGreaterThanOrEqual(initialGeometry.userBottom);
  expect(initialGeometry.assistantTop).toBeLessThan(initialGeometry.viewportBottom + 32);
  expect(initialGeometry.distanceFromBottom).toBeLessThanOrEqual(96);

  await streamedContent.click();
  await expect(sentAssistant).toContainText("Línea de crecimiento 20.");
  const grownGeometry = await scroll.evaluate(
    (container, userId) => ({
      distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
      scrollTop: container.scrollTop,
      userTop: container
        .querySelector<HTMLElement>(`[data-message-id="${userId}"]`)
        ?.getBoundingClientRect().top,
    }),
    sentUserId,
  );
  expect(grownGeometry.distanceFromBottom).toBeLessThan(3);

  await scroll.hover();
  await page.mouse.wheel(0, -700);
  await expect
    .poll(() => scroll.evaluate((container) => container.scrollTop))
    .toBeLessThan(grownGeometry.scrollTop - 96);
  const disengagedTop = await scroll.evaluate((container) => container.scrollTop);
  const selectedText = await streamedContent.evaluate((message) => {
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const start = text.textContent?.indexOf("Selección estable") ?? -1;
      if (start < 0) {
        continue;
      }
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + "Selección estable".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? "";
    }
    throw new Error("The streamed response has no selectable Markdown fragment");
  });
  expect(selectedText).toBe("Selección estable");
  await expect(sentAssistant).toContainText("Contenido no visto 12.");
  const jump = page.getByRole("button", { name: copy.conversations.scroll.jumpToLatest });
  await expect(jump).toBeVisible();
  expect(
    Math.abs((await scroll.evaluate((container) => container.scrollTop)) - disengagedTop),
  ).toBeLessThan(3);
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe(selectedText);

  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect
    .poll(() =>
      scroll.evaluate(
        (container) => container.scrollHeight - container.scrollTop - container.clientHeight,
      ),
    )
    .toBeLessThan(3);
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe(selectedText);
  await expect(sentAssistant).toContainText("Fragmento seguido después del salto.");
  await expect(jump).toHaveCount(0);
  await expect
    .poll(() =>
      scroll.evaluate(
        (container) => container.scrollHeight - container.scrollTop - container.clientHeight,
      ),
    )
    .toBeLessThan(3);
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe(selectedText);
  await expect(sentAssistant).toContainText("Cierre final seguido.");
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe(selectedText);
  await expect(jump).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.send }),
  ).toBeVisible();
});

test("@critical-stream reloads canonical active state and remotely stops without losing the draft", async ({
  page,
}) => {
  const conversationId = browserUuid(10);
  const userMessageId = browserUuid(11);
  const assistantMessageId = browserUuid(12);
  const generationId = browserUuid(13);
  const fixture = await installStreamingFixture(page, [
    {
      id: conversationId,
      title: "Respuesta remota",
      revision: 1,
      selectedLeafId: assistantMessageId,
      draft: {
        content: "Borrador remoto intacto.",
        revision: 2,
        updatedAt: "2026-08-07T12:00:00.000Z",
      },
      messages: [
        browserMessage({
          id: userMessageId,
          parentMessageId: null,
          role: "user",
          text: "Solicitud iniciada en otra pestaña.",
        }),
        browserMessage({
          id: assistantMessageId,
          parentMessageId: userMessageId,
          role: "assistant",
          text: "Salida parcial remota.",
        }),
      ],
      responses: [
        {
          generationId,
          messageId: assistantMessageId,
          status: "active",
          reason: null,
          errorCode: null,
        },
      ],
    },
  ]);

  await page.goto(`/c/${conversationId}`);
  const stop = page.getByRole("button", { name: copy.conversations.generation.actions.stop });
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(stop).toBeVisible();
  await expect(draft).toHaveValue("Borrador remoto intacto.");
  await expect(page.getByText("Salida parcial remota.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(
    page
      .locator(".response-outcome")
      .filter({ hasText: copy.conversations.generation.terminal.cancelled }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.send }),
  ).toBeVisible();
  await expect(draft).toHaveValue("Borrador remoto intacto.");
  expect(fixture.cancellations).toEqual([{ conversationId, generationId }]);
});

test("recovers canonical interrupted output without retrying the generation", async ({ page }) => {
  const conversationId = browserUuid(20);
  const fixture = await installStreamingFixture(page, [
    {
      id: conversationId,
      title: "Interrupción recuperable",
      streams: [
        {
          deltas: [{ delayMilliseconds: 40, text: "Contenido parcial conservado." }],
          outcome: "interrupted",
        },
      ],
    },
  ]);

  await page.goto(`/c/${conversationId}`);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await draft.fill("Provoca una interrupción controlada.");
  await page.getByRole("button", { name: copy.conversations.generation.actions.send }).click();

  await expect(page.getByText("Contenido parcial conservado.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(copy.conversations.generation.terminal.incomplete, { exact: true }),
  ).toBeVisible();
  await draft.fill("Nuevo borrador después de la interrupción.");
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.send }),
  ).toBeEnabled();
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.conversation(conversationId).responses[0]?.status).toBe("incomplete");
});

test("continues a length response while preserving a separately saved draft", async ({ page }) => {
  const conversationId = browserUuid(30);
  const userMessageId = browserUuid(31);
  const assistantMessageId = browserUuid(32);
  const generationId = browserUuid(33);
  const fixture = await installStreamingFixture(page, [
    {
      id: conversationId,
      title: "Continuación explícita",
      revision: 2,
      selectedLeafId: assistantMessageId,
      draft: {
        content: "Borrador separado y guardado.",
        revision: 3,
        updatedAt: "2026-08-07T12:00:00.000Z",
      },
      messages: [
        browserMessage({
          id: userMessageId,
          parentMessageId: null,
          role: "user",
          text: "Respuesta extensa.",
        }),
        browserMessage({
          id: assistantMessageId,
          parentMessageId: userMessageId,
          role: "assistant",
          text: "Primera parte truncada.",
        }),
      ],
      responses: [
        {
          generationId,
          messageId: assistantMessageId,
          status: "completed",
          reason: "length",
          errorCode: null,
        },
      ],
      streams: [
        {
          deltas: [{ delayMilliseconds: 40, text: "Continuación visible." }],
          outcome: "completed",
        },
      ],
    },
  ]);

  await page.goto(`/c/${conversationId}`);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(draft).toHaveValue("Borrador separado y guardado.");
  await page.getByRole("button", { name: copy.conversations.generation.actions.continue }).click();
  await expect(draft).toBeFocused();

  await expect(page.getByText("Continuación visible.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Continúa desde donde te detuviste, manteniendo el idioma y el formato de la respuesta anterior.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(draft).toHaveValue("Borrador separado y guardado.");
  expect(fixture.draftWrites).toHaveLength(0);
  expect(fixture.starts[0]).toEqual({
    conversationId,
    request: {
      source: "continue",
      parentMessageId: assistantMessageId,
      modelTier: "balanced",
      observedRevision: 2,
    },
  });
});

test("@critical-stream uses mobile Enter for a newline and the visible action for sending", async ({
  page,
}) => {
  const conversationId = browserUuid(40);
  const fixture = await installStreamingFixture(page, [
    {
      id: conversationId,
      title: "Composer móvil",
      streams: [
        {
          deltas: [{ delayMilliseconds: 80, text: "Respuesta móvil parcial." }],
          outcome: "hold",
        },
      ],
    },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/c/${conversationId}`);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });

  await draft.fill(Array.from({ length: 18 }, (_, index) => `Línea larga ${index + 1}`).join("\n"));
  const growth = await draft.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(growth.scrollHeight).toBeGreaterThan(growth.clientHeight);

  await draft.fill("Primera línea");
  await draft.press("Enter");
  await draft.type("Segunda línea");
  await expect(draft).toHaveValue("Primera línea\nSegunda línea");
  expect(fixture.starts).toHaveLength(0);
  await page.getByRole("button", { name: copy.conversations.generation.actions.send }).click();
  await expect(
    page.getByRole("button", { name: copy.conversations.generation.actions.stop }),
  ).toBeVisible();
  await expect(draft).toBeFocused();
  expect(fixture.starts[0]?.request).toMatchObject({
    source: "draft",
    content: [{ type: "text", text: "Primera línea\nSegunda línea" }],
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: copy.conversations.generation.actions.stop }).click();
  await expect(
    page
      .locator(".response-outcome")
      .filter({ hasText: copy.conversations.generation.terminal.cancelled }),
  ).toBeVisible();
});
