import { expect, type Locator, type Page } from "@playwright/test";

import { copy } from "../../src/copy";
import { openConversation, phaseFiveBrowserFixtures } from "./phase5-fixture";

const simulatedResponse = "Esta es una respuesta simulada de Capstone Chat para desarrollo local.";

async function completeGenerationWithAdmissionRetry(
  trigger: Locator,
  completion: Locator,
  admissionError: Locator,
): Promise<void> {
  let attempted = false;
  await expect
    .poll(
      async () => {
        if (await completion.isVisible().catch(() => false)) {
          return true;
        }
        if (
          (!attempted || (await admissionError.isVisible().catch(() => false))) &&
          (await trigger.isVisible().catch(() => false)) &&
          (await trigger.isEnabled().catch(() => false))
        ) {
          await trigger.click();
          attempted = true;
        }
        return false;
      },
      { intervals: [250, 500, 1_000], timeout: 30_000 },
    )
    .toBe(true);
}

export async function exerciseConversationControls(
  page: Page,
  projectName: string,
  isMobile: boolean,
): Promise<void> {
  const title = Object.entries(phaseFiveBrowserFixtures.controlsTitles).find(
    ([project]) => project === projectName,
  )?.[1];
  if (!title) {
    throw new Error(`No control fixture exists for ${projectName}`);
  }

  if (!isMobile) {
    await page.setViewportSize({ width: 1_280, height: 800 });
  }
  await openConversation(page, title, isMobile);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  const firstAnswer = page
    .locator(".message-assistant")
    .filter({ hasText: "Primera respuesta preservada." });
  const nextAlternative = firstAnswer.getByRole("button", {
    name: copy.conversations.messages.nextAlternative,
  });
  await expect(nextAlternative).toBeEnabled();
  await nextAlternative.click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsNextBranchText, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalBranchText, { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(copy.conversations.messages.branchSelected, { exact: true }),
  ).toBeVisible();

  const secondAnswer = page
    .locator(".message-assistant")
    .filter({ hasText: "Segunda respuesta preservada." });
  const previousAlternative = secondAnswer.getByRole("button", {
    name: copy.conversations.messages.previousAlternative,
  });
  await expect(previousAlternative).toBeEnabled();
  await previousAlternative.click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalBranchText, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsNextBranchText, { exact: true }),
  ).toHaveCount(0);

  const selectedLeaf = page
    .locator(".message-assistant")
    .filter({ hasText: phaseFiveBrowserFixtures.controlsOriginalBranchText });
  await selectedLeaf.getByRole("button", { name: copy.conversations.messages.undo }).click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalBranchText, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Primera respuesta preservada.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(copy.conversations.messages.turnUndone, { exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  const rootMessage = page
    .locator(".message-user")
    .filter({ hasText: phaseFiveBrowserFixtures.controlsOriginalRoot });
  const rootMessageId = await rootMessage.getAttribute("data-message-id");
  if (!rootMessageId) {
    throw new Error("The selected control branch has no root user identifier");
  }
  const rootMessageById = page.locator(`[data-message-id="${rootMessageId}"]`);
  await rootMessage.getByRole("button", { name: copy.conversations.messages.edit }).click();
  const editor = rootMessageById.getByRole("textbox", {
    name: copy.conversations.messages.editLabel,
  });
  await editor.fill("Primera línea");
  await editor.press("Enter");
  await editor.type("Segunda línea");
  await expect(editor).toHaveValue("Primera línea\nSegunda línea");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  await rootMessageById.getByRole("button", { name: copy.conversations.messages.edit }).click();
  const committedEditor = rootMessageById.getByRole("textbox", {
    name: copy.conversations.messages.editLabel,
  });
  await committedEditor.fill(phaseFiveBrowserFixtures.controlsEditedRoot);
  const editedRoot = page.getByText(phaseFiveBrowserFixtures.controlsEditedRoot, { exact: true });
  const committedMessage = page
    .locator(".message-user")
    .filter({ hasText: phaseFiveBrowserFixtures.controlsEditedRoot });
  const admissionError = page.getByText(copy.conversations.generation.errors.generationLimit, {
    exact: true,
  });
  await completeGenerationWithAdmissionRetry(
    rootMessageById.getByRole("button", { name: copy.conversations.messages.saveEdit }),
    committedMessage.getByRole("button", { name: copy.conversations.messages.edit }),
    admissionError,
  );
  await expect(editedRoot).toBeVisible();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalRoot, { exact: true }),
  ).toHaveCount(0);
  const generatedResponse = page.getByText(simulatedResponse, { exact: true });
  await expect(generatedResponse).toBeVisible();
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  const editedAnswer = page.locator(".message-assistant").filter({ hasText: simulatedResponse });
  const retriedAnswer = page.locator(".message-assistant").filter({ hasText: simulatedResponse });
  const secondAlternative = retriedAnswer.getByText("2 / 2", { exact: true });
  await completeGenerationWithAdmissionRetry(
    editedAnswer.getByRole("button", { name: copy.conversations.messages.tryAgain }),
    secondAlternative,
    admissionError,
  );
  await expect(generatedResponse).toBeVisible();
  await expect(secondAlternative).toBeVisible();
  await expect(
    page.locator(".message-user").filter({ hasText: phaseFiveBrowserFixtures.controlsEditedRoot }),
  ).toHaveCount(1);
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  await page.reload();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsEditedRoot, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(simulatedResponse, { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  await page.getByRole("button", { name: copy.conversations.conversation.archive }).click();
  await expect(
    page.getByRole("button", { name: copy.conversations.conversation.unarchive }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.conversations.messages.copyAnswer }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.conversations.messages.tryAgain }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: copy.conversations.messages.edit })).toHaveCount(0);
  const archivedSelectedAnswer = page
    .locator(".message-assistant")
    .filter({ hasText: simulatedResponse });
  await expect(
    archivedSelectedAnswer.getByRole("button", {
      name: copy.conversations.messages.previousAlternative,
    }),
  ).toBeEnabled();
}
