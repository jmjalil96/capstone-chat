import { expect, type Locator, type Page, test } from "@playwright/test";

import { copy } from "../src/copy";
import { expectReviewedWcagState } from "./support/accessibility";
import { installChatShellFixture } from "./support/chat-shell-fixture";

async function expectViewportContained(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        if (getComputedStyle(element).display === "none") return false;
        const box = element.getBoundingClientRect();
        return box.left < -1 || box.right > document.documentElement.clientWidth + 1;
      })
      .slice(0, 8)
      .map((element) => ({
        box: element.getBoundingClientRect().toJSON(),
        className: element.className,
        parentBox: element.parentElement?.getBoundingClientRect().toJSON(),
        parentClassName: element.parentElement?.className,
        tagName: element.tagName,
      })),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry, "the chat shell must not overflow the viewport").toMatchObject({
    clientWidth: geometry.scrollWidth,
    offenders: [],
  });
}

async function expectMinimumTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

async function expectConversationFocusAccent(region: Locator): Promise<void> {
  const presentation = await region.evaluate((article) => {
    const title = article.querySelector(".conversation-title");
    if (!title) throw new Error("Conversation title is unavailable.");
    const colorProbe = document.createElement("span");
    colorProbe.style.color = "var(--app-action)";
    article.append(colorProbe);
    const actionColor = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    const articleStyle = getComputedStyle(article);
    const titleStyle = getComputedStyle(title);
    return {
      actionColor,
      articleFocused: document.activeElement === article,
      boxShadow: articleStyle.boxShadow,
      outlineStyle: articleStyle.outlineStyle,
      titleAccentColor: titleStyle.borderInlineStartColor,
      titleAccentStyle: titleStyle.borderInlineStartStyle,
      titleAccentWidth: Number.parseFloat(titleStyle.borderInlineStartWidth),
    };
  });
  expect(presentation).toMatchObject({
    articleFocused: true,
    outlineStyle: "none",
    titleAccentStyle: "solid",
  });
  // :focus-visible heuristics vary by how focus arrived: the region either shows
  // no shadow (pointer-driven focus) or exactly the single-edge leading accent.
  expect(
    presentation.boxShadow === "none" ||
      (presentation.boxShadow.includes("inset") &&
        presentation.boxShadow.includes(presentation.actionColor)),
  ).toBe(true);
  expect(presentation.titleAccentColor).toBe(presentation.actionColor);
  expect(presentation.titleAccentWidth).toBeGreaterThanOrEqual(3);
}

async function expectPopoverWithinClipRoot(page: Page, rootSelector: string): Promise<void> {
  // Ancestor overflow clipping is invisible to toBeVisible(): compare the panel
  // and its first option against the clipping root, not just the viewport. The
  // popover re-measures on the frame after resize events, so poll until settled.
  await expect
    .poll(
      () =>
        page.evaluate((selector) => {
          const root = document.querySelector(selector);
          const panel = document.querySelector(".model-tier-popover");
          const option = panel?.querySelector(".model-tier-option");
          if (!root || !panel || !option) {
            return ["popover clip geometry unavailable"];
          }
          const rootBox = root.getBoundingClientRect();
          const violations: string[] = [];
          for (const [name, box] of [
            ["panel", panel.getBoundingClientRect()],
            ["option", option.getBoundingClientRect()],
          ] as const) {
            if (box.top < rootBox.top - 1) {
              violations.push(`${name} top ${box.top} above root ${rootBox.top}`);
            }
            if (box.bottom > rootBox.bottom + 1) {
              violations.push(`${name} bottom ${box.bottom} below root ${rootBox.bottom}`);
            }
          }
          return violations;
        }, rootSelector),
      { message: "the tier popover must stay inside its clipping root", timeout: 5_000 },
    )
    .toEqual([]);
}

async function expectChildrenContained(container: Locator): Promise<void> {
  const offenders = await container.evaluate((element) => {
    const boundary = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>("*")]
      .filter((child) => {
        const box = child.getBoundingClientRect();
        if ((box.width === 0 && box.height === 0) || getComputedStyle(child).display === "none") {
          return false;
        }
        let ancestor = child.parentElement;
        while (ancestor && ancestor !== element) {
          const overflow = getComputedStyle(ancestor).overflowX;
          if (overflow === "hidden" || overflow === "clip") return false;
          ancestor = ancestor.parentElement;
        }
        return box.left < boundary.left - 1 || box.right > boundary.right + 1;
      })
      .map((child) => ({ className: child.className, tagName: child.tagName }));
  });
  expect(offenders, "shell content must remain inside its surface").toEqual([]);
}

test("@critical-chat keeps the current conversation and compact composer coherent across shell variants", async ({
  page,
}, testInfo) => {
  const fixture = await installChatShellFixture(page, { holdCurrentDetail: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1_280, height: 720 });
  await page.goto(`/c/${fixture.currentId}`);

  const region = page.getByRole("article", { name: fixture.currentTitle });
  const desktopSidebar = page.locator(".desktop-sidebar");
  const actionLabel = copy.conversations.conversation.actionsLabel(fixture.currentTitle);
  const currentLink = desktopSidebar.locator(`a[href="/c/${fixture.currentId}"]`);
  const tier = page.getByRole("button", {
    name: new RegExp(`^${copy.conversations.modelTiers.label}:`, "u"),
  });
  const tierPopover = page.locator(".model-tier-popover");
  const pendingCurrent = desktopSidebar.locator(".current-conversation-placeholder");
  await expect(pendingCurrent).toBeVisible();
  const pendingTitle = pendingCurrent.locator(".current-conversation-title-placeholder");
  await expect(pendingTitle).toBeVisible();
  const pendingTitlePresentation = await pendingTitle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      backgroundColor: getComputedStyle(element).backgroundColor,
      height: box.height,
      width: box.width,
    };
  });
  expect(pendingTitlePresentation.width).toBeGreaterThan(0);
  expect(pendingTitlePresentation.height).toBeGreaterThan(0);
  expect(pendingTitlePresentation.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect(desktopSidebar.locator(".conversation-action-placeholder")).toBeVisible();
  await expect(desktopSidebar.getByRole("button", { name: actionLabel })).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 720 });
  const pendingMobileHeader = page.locator(".mobile-conversation-header");
  await expect(pendingMobileHeader.locator(".current-conversation-placeholder")).toBeVisible();
  await expect(pendingMobileHeader.locator(".conversation-action-placeholder")).toBeVisible();
  await expect(pendingMobileHeader.locator("img")).toHaveCount(0);
  expect((await pendingMobileHeader.boundingBox())?.height ?? 0).toBeCloseTo(64, 0);
  await page.setViewportSize({ width: 1_280, height: 720 });
  await expect(pendingCurrent).toBeVisible();
  const pendingGeometry = await desktopSidebar.evaluate((sidebar) => {
    const current = sidebar.querySelector(".current-conversation-row");
    const recent = sidebar.querySelector(".recent-section");
    if (!current || !recent) throw new Error("Pending shell geometry is unavailable.");
    return {
      currentHeight: current.getBoundingClientRect().height,
      recentTop: recent.getBoundingClientRect().top,
    };
  });
  fixture.releaseCurrentDetail();
  await expect(region).toBeFocused();
  await expect(page).toHaveTitle(new RegExp(fixture.currentTitle, "u"));
  const conversationTitle = page.getByRole("heading", { level: 1, name: fixture.currentTitle });
  await expect(conversationTitle).toBeVisible();
  await expect(conversationTitle).toHaveCount(1);
  expect(
    await conversationTitle.evaluate((heading) => {
      const parent = heading.parentElement;
      return (
        parent?.classList.contains("message-scroll") === true &&
        parent.firstElementChild === heading
      );
    }),
  ).toBe(true);
  const loadedGeometry = await desktopSidebar.evaluate((sidebar) => {
    const current = sidebar.querySelector(".current-conversation-row");
    const recent = sidebar.querySelector(".recent-section");
    if (!current || !recent) throw new Error("Loaded shell geometry is unavailable.");
    return {
      currentHeight: current.getBoundingClientRect().height,
      recentTop: recent.getBoundingClientRect().top,
    };
  });
  expect(loadedGeometry.currentHeight).toBeCloseTo(pendingGeometry.currentHeight, 0);
  expect(loadedGeometry.recentTop).toBeCloseTo(pendingGeometry.recentTop, 0);
  await expectConversationFocusAccent(region);
  await expect(
    desktopSidebar.getByText(copy.conversations.navigation.current, { exact: true }),
  ).toBeVisible();
  await expectChildrenContained(desktopSidebar.locator(".sidebar-contents"));
  await expect(page.locator(".action-dialog")).toHaveCount(2);
  await expectViewportContained(page);
  expect(
    await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    }),
  ).toEqual([]);
  await expect(currentLink).toHaveCount(1);
  await expect(desktopSidebar.getByRole("link", { name: fixture.currentTitle })).toHaveCount(2);
  await desktopSidebar.getByRole("button", { name: copy.conversations.common.loadMore }).click();
  await expect(currentLink).toHaveCount(1);

  await expect(tier).toContainText(copy.conversations.modelTiers.tiers.balanced.name);
  await expect(tier).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(copy.conversations.modelTiers.tiers.balanced.purpose)).toHaveCount(0);
  await expectMinimumTarget(tier);
  await tier.click();
  await expect(tier).toHaveAttribute("aria-expanded", "true");
  await expect(tierPopover).toBeVisible();
  const tierRows = tierPopover.locator(".model-tier-option");
  await expect(tierRows).toHaveCount(3);
  for (const tierKey of ["fast", "balanced", "pro"] as const) {
    await expect(
      tierPopover.getByText(copy.conversations.modelTiers.tiers[tierKey].purpose),
    ).toBeVisible();
  }
  const selectedTierRow = tierPopover.locator('[aria-pressed="true"]');
  await expect(selectedTierRow).toHaveCount(1);
  await expect(selectedTierRow).toContainText(copy.conversations.modelTiers.tiers.balanced.name);
  await expect(tierPopover.locator('[role="menu"], [role="menuitem"]')).toHaveCount(0);
  for (const row of await tierRows.all()) {
    await expectMinimumTarget(row);
  }
  if (testInfo.project.name === "chromium") {
    await expectReviewedWcagState(page, testInfo, "chat-tier-popover");
  }
  await page.keyboard.press("Escape");
  await expect(tierPopover).toHaveCount(0);
  await expect(tier).toBeFocused();
  await expect(tier).toHaveAttribute("aria-expanded", "false");
  const composer = page.locator(".composer-control");
  const textarea = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await textarea.focus();
  const composerFocus = await composer.evaluate((element) => {
    const textarea = element.querySelector("textarea");
    if (!textarea) throw new Error("Composer textarea is unavailable.");
    const outer = getComputedStyle(element);
    const inner = getComputedStyle(textarea);
    return {
      borderBlockEndColor: outer.borderBlockEndColor,
      borderBlockStartColor: outer.borderBlockStartColor,
      innerOutline: inner.outlineStyle,
      outerOutlineColor: outer.outlineColor,
      outerOutline: outer.outlineStyle,
      outerOutlineWidth: Number.parseFloat(outer.outlineWidth),
    };
  });
  expect(composerFocus).toMatchObject({
    innerOutline: "none",
    outerOutline: "solid",
  });
  expect(composerFocus.outerOutlineWidth).toBeGreaterThanOrEqual(3);
  expect(composerFocus.borderBlockStartColor).toBe(composerFocus.borderBlockEndColor);
  expect(composerFocus.borderBlockStartColor).not.toBe(composerFocus.outerOutlineColor);
  await tier.click();
  await tierPopover
    .locator(".model-tier-option")
    .filter({ hasText: copy.conversations.modelTiers.tiers.pro.name })
    .click();
  await expect(tierPopover).toHaveCount(0);
  await expect(tier).toContainText(copy.conversations.modelTiers.tiers.pro.name);
  await expect(page.getByText(copy.conversations.modelTiers.tiers.pro.purpose)).toHaveCount(0);
  expect(fixture.tierWrites).toEqual(["pro"]);

  let actionTrigger = page.getByRole("button", { name: actionLabel });
  await expectMinimumTarget(actionTrigger);
  await expect(actionTrigger).toHaveAttribute("aria-expanded", "false");
  await actionTrigger.click();
  await expect(actionTrigger).toHaveAttribute("aria-expanded", "true");
  const disclosure = page.locator(".conversation-action-panel");
  await expect(disclosure).toBeVisible();
  const disclosureBox = await disclosure.boundingBox();
  expect(disclosureBox).not.toBeNull();
  expect(disclosureBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(200);
  expect(disclosureBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(152);
  await expect(page.locator('[role="menu"], [role="menuitem"]')).toHaveCount(0);
  for (const button of await disclosure.getByRole("button").all()) {
    await expectMinimumTarget(button);
  }
  if (testInfo.project.name === "chromium") {
    await expectReviewedWcagState(page, testInfo, "chat-action-disclosure");
  }
  await page.keyboard.press("Escape");
  await expect(disclosure).not.toBeVisible();
  await expect(actionTrigger).toBeFocused();

  // The two disclosures are mutually exclusive: opening one dismisses the other.
  await tier.click();
  await expect(tierPopover).toBeVisible();
  await actionTrigger.click();
  await expect(disclosure).toBeVisible();
  await expect(tierPopover).toHaveCount(0);
  await tier.click();
  await expect(tierPopover).toBeVisible();
  await expect(disclosure).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tierPopover).toHaveCount(0);

  await actionTrigger.click();
  await page.locator(".message-scroll").click({ position: { x: 8, y: 8 } });
  await expect(disclosure).not.toBeVisible();
  await expect(actionTrigger).toBeFocused();
  await actionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.rename }).click();
  const renameDialog = page.getByRole("dialog", {
    name: copy.conversations.conversation.renameTitle,
  });
  await expect(renameDialog).toBeVisible();
  if (testInfo.project.name === "chromium") {
    await expectReviewedWcagState(page, testInfo, "chat-rename-dialog");
  }
  await renameDialog.getByRole("button", { name: copy.conversations.conversation.cancel }).click();
  await expect(actionTrigger).toBeFocused();

  await actionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.delete }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: copy.conversations.conversation.deleteTitle,
  });
  await expect(deleteDialog).toBeVisible();
  if (testInfo.project.name === "chromium") {
    await expectReviewedWcagState(page, testInfo, "chat-delete-dialog");
  }
  await deleteDialog.getByRole("button", { name: copy.conversations.conversation.cancel }).click();
  await expect(actionTrigger).toBeFocused();

  await actionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.archive }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${fixture.currentId}$`, "u"));
  await expect(
    desktopSidebar.getByText(copy.conversations.conversation.archivedState, { exact: true }),
  ).toBeVisible();
  await expect(actionTrigger).toBeFocused();
  await actionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.unarchive }).click();
  await expect(
    desktopSidebar.getByText(copy.conversations.conversation.archivedState, { exact: true }),
  ).toHaveCount(0);
  await expect(actionTrigger).toBeFocused();

  await desktopSidebar.getByRole("link", { name: copy.conversations.navigation.search }).click();
  await page.getByLabel(copy.conversations.search.label).fill("fuera");
  await page.getByRole("button", { name: new RegExp(fixture.deepTitle, "u") }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${fixture.deepId}$`, "u"));
  const deepRegion = page.getByRole("article", { name: fixture.deepTitle });
  await expect(deepRegion).toBeFocused();
  await expectConversationFocusAccent(deepRegion);
  await expect(desktopSidebar.locator(`a[href="/c/${fixture.deepId}"]`)).toHaveCount(1);

  // With the in-flow title scrolled out of view, keyboard-visible focus keeps an
  // in-viewport leading accent on the region itself.
  await page.keyboard.press("Tab");
  const deepFocusCue = await page.evaluate(() => {
    const article = document.querySelector<HTMLElement>(".conversation-page");
    const scroll = document.querySelector<HTMLElement>(".message-scroll");
    const title = document.querySelector<HTMLElement>(".conversation-title");
    if (!article || !scroll || !title) {
      throw new Error("Deep focus geometry is unavailable.");
    }
    scroll.scrollTop = scroll.scrollHeight;
    article.focus();
    const probe = document.createElement("span");
    probe.style.color = "var(--app-action)";
    article.append(probe);
    const actionColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      actionColor,
      boxShadow: getComputedStyle(article).boxShadow,
      titleOffscreen: title.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top,
    };
  });
  expect(deepFocusCue.titleOffscreen).toBe(true);
  expect(deepFocusCue.boxShadow).toContain("inset");
  expect(deepFocusCue.boxShadow).toContain(deepFocusCue.actionColor);

  await page.goto(`/c/${fixture.currentId}`);
  await expect(region).toBeFocused();
  // Keyboard collapse with the action panel open keeps focus on the collapse
  // control instead of handing it to the replacement context-strip trigger.
  await page.getByRole("button", { name: actionLabel }).click();
  await expect(disclosure).toBeVisible();
  await desktopSidebar
    .getByRole("button", { name: copy.conversations.navigation.collapse })
    .focus();
  await expect(disclosure).not.toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".conversation-context-strip")).toBeVisible();
  await expect(
    desktopSidebar.getByRole("button", { name: copy.conversations.navigation.expand }),
  ).toBeFocused();
  await page.setViewportSize({ width: 769, height: 720 });
  await expect(page.locator(".conversation-context-strip")).toBeVisible();
  await expectViewportContained(page);
  actionTrigger = page.getByRole("button", { name: actionLabel });
  await actionTrigger.click();
  await page.getByRole("button", { name: copy.conversations.conversation.rename }).click();
  await expect(renameDialog).toBeVisible();
  await page.setViewportSize({ width: 768, height: 720 });
  const mobileActionTrigger = page.getByRole("button", { name: actionLabel });
  await expect(page.locator(".mobile-conversation-header")).toBeVisible();
  await expect(page.locator(".conversation-context-strip")).not.toBeVisible();
  await expectViewportContained(page);
  await renameDialog.getByRole("button", { name: copy.conversations.conversation.cancel }).click();
  await expect(mobileActionTrigger).toBeFocused();
  await expectMinimumTarget(mobileActionTrigger);

  const drawerOpener = page.getByRole("button", { name: copy.conversations.navigation.open });
  await drawerOpener.click();
  const drawer = page.getByRole("dialog", { name: copy.conversations.navigation.label });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(`a[href="/c/${fixture.currentId}"]`)).toHaveCount(1);
  await expect(drawer.getByRole("button", { name: actionLabel })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(drawerOpener).toBeFocused();

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(tier).toBeVisible();
    await expectMinimumTarget(
      page.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await expectMinimumTarget(tier);
    await tier.click();
    await expect(tierPopover).toBeVisible();
    await expect(
      tierPopover.getByText(copy.conversations.modelTiers.tiers.pro.purpose),
    ).toBeVisible();
    const popoverBox = await tierPopover.boundingBox();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(
      (popoverBox?.x ?? 0) + (popoverBox?.width ?? Number.POSITIVE_INFINITY),
    ).toBeLessThanOrEqual(viewport.width + 1);
    expect(popoverBox?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(
      (popoverBox?.y ?? 0) + (popoverBox?.height ?? Number.POSITIVE_INFINITY),
    ).toBeLessThanOrEqual(viewport.height + 1);
    await page.keyboard.press("Escape");
    await expect(tierPopover).toHaveCount(0);
    const tierGeometry = await tier.evaluate((trigger) => {
      if (!(trigger instanceof HTMLElement)) {
        throw new Error("Tier trigger geometry is unavailable.");
      }
      return {
        clientWidth: trigger.clientWidth,
        offsetWidth: trigger.offsetWidth,
        right: trigger.getBoundingClientRect().right,
        scrollWidth: trigger.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(tierGeometry.clientWidth).toBeGreaterThan(0);
    expect(tierGeometry.scrollWidth).toBeLessThanOrEqual(tierGeometry.offsetWidth);
    expect(tierGeometry.right).toBeLessThanOrEqual(tierGeometry.viewportWidth + 1);
    await expectViewportContained(page);
  }

  await page.setViewportSize({ width: 1_280, height: 720 });
  await desktopSidebar.getByRole("button", { name: copy.conversations.navigation.expand }).click();
  await expect(page.locator(".conversation-context-strip")).not.toBeVisible();
  const textScale = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectViewportContained(page);
  const textScaleGeometry = await page.evaluate(() => {
    const navigation = document.querySelector(".desktop-sidebar .conversation-navigation");
    const footer = document.querySelector(".desktop-sidebar .sidebar-footer");
    const trigger = document.querySelector(".model-tier-trigger");
    if (!navigation || !footer || !trigger) {
      throw new Error("Text-scale geometry is unavailable.");
    }
    const navigationBox = navigation.getBoundingClientRect();
    return {
      footerTop: footer.getBoundingClientRect().top,
      navigationBottom: navigationBox.bottom,
      navigationClientHeight: navigation.clientHeight,
      navigationOverflow: getComputedStyle(navigation).overflowY,
      navigationScrollHeight: navigation.scrollHeight,
      triggerBottom: trigger.getBoundingClientRect().bottom,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(textScaleGeometry.navigationOverflow).toBe("auto");
  expect(textScaleGeometry.navigationBottom).toBeLessThanOrEqual(textScaleGeometry.footerTop + 1);
  expect(textScaleGeometry.navigationScrollHeight).toBeGreaterThan(
    textScaleGeometry.navigationClientHeight,
  );
  expect(textScaleGeometry.triggerBottom).toBeLessThanOrEqual(textScaleGeometry.viewportHeight + 1);
  await tier.click();
  await expect(tierPopover).toBeVisible();
  const textScalePopover = await tierPopover.evaluate((panel) => {
    const purpose = panel.querySelector(".model-tier-option-purpose");
    if (!purpose) {
      throw new Error("Popover purpose is unavailable.");
    }
    const panelBox = panel.getBoundingClientRect();
    const purposeBox = purpose.getBoundingClientRect();
    const purposeStyle = getComputedStyle(purpose);
    return {
      panelBottom: panelBox.bottom,
      panelTop: panelBox.top,
      purposeFontSize: Number.parseFloat(purposeStyle.fontSize),
      purposeWidth: purposeBox.width,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(textScalePopover.purposeWidth / textScalePopover.purposeFontSize).toBeGreaterThanOrEqual(
    8,
  );
  expect(textScalePopover.panelTop).toBeGreaterThanOrEqual(0);
  expect(textScalePopover.panelBottom).toBeLessThanOrEqual(textScalePopover.viewportHeight + 1);
  await page.keyboard.press("Escape");
  await expect(tierPopover).toHaveCount(0);

  const textScaleActionTrigger = desktopSidebar.getByRole("button", { name: actionLabel });
  await textScaleActionTrigger.scrollIntoViewIfNeeded();
  await expectMinimumTarget(textScaleActionTrigger);
  await textScaleActionTrigger.click();
  await expect(disclosure).toBeVisible();
  const textScaleDisclosure = await desktopSidebar.evaluate((sidebar) => {
    const navigation = sidebar.querySelector(".conversation-navigation");
    const panel = sidebar.querySelector(".conversation-action-panel");
    if (!navigation || !panel) throw new Error("Text-scale action geometry is unavailable.");
    const navigationBox = navigation.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      navigationBottom: navigationBox.bottom,
      navigationTop: navigationBox.top,
      panelBottom: panelBox.bottom,
      panelTop: panelBox.top,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(textScaleDisclosure.panelTop).toBeGreaterThanOrEqual(
    textScaleDisclosure.navigationTop - 1,
  );
  expect(textScaleDisclosure.panelBottom).toBeLessThanOrEqual(
    textScaleDisclosure.navigationBottom + 1,
  );
  expect(textScaleDisclosure.panelBottom).toBeLessThanOrEqual(
    textScaleDisclosure.viewportHeight + 1,
  );
  await page.keyboard.press("Escape");
  await expect(textScaleActionTrigger).toBeFocused();
  await textScale.evaluate((element) => element.parentNode?.removeChild(element));
  await desktopSidebar
    .getByRole("button", { name: copy.conversations.navigation.collapse })
    .click();
  await expect(page.locator(".conversation-context-strip")).toBeVisible();

  await page.setViewportSize({ width: 844, height: 320 });
  await expect(page.locator(".conversation-context-strip")).toBeVisible();
  await expect(page.getByRole("article", { name: fixture.currentTitle })).toBeVisible();
  const collapsedMessageHeight = await page
    .locator(".message-scroll")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(collapsedMessageHeight).toBeGreaterThanOrEqual(120);
  await tier.click();
  await expect(tierPopover).toBeVisible();
  const landscapePopoverBox = await tierPopover.boundingBox();
  expect(landscapePopoverBox).not.toBeNull();
  expect(landscapePopoverBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (landscapePopoverBox?.y ?? 0) + (landscapePopoverBox?.height ?? Number.POSITIVE_INFINITY),
  ).toBeLessThanOrEqual(321);
  expect(landscapePopoverBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (landscapePopoverBox?.x ?? 0) + (landscapePopoverBox?.width ?? Number.POSITIVE_INFINITY),
  ).toBeLessThanOrEqual(845);
  await expectPopoverWithinClipRoot(page, ".conversation-route");
  // Shrinking the viewport while the popover stays open must re-measure it.
  await page.setViewportSize({ width: 844, height: 260 });
  await expect(tierPopover).toBeVisible();
  await expectPopoverWithinClipRoot(page, ".conversation-route");
  await page.setViewportSize({ width: 844, height: 320 });
  await expect(tierPopover).toBeVisible();
  await expectPopoverWithinClipRoot(page, ".conversation-route");
  await page.keyboard.press("Escape");
  await expect(tierPopover).toHaveCount(0);
  await desktopSidebar.getByRole("button", { name: copy.conversations.navigation.expand }).click();
  await expect(page.locator(".conversation-context-strip")).not.toBeVisible();
  const expandedMessageHeight = await page
    .locator(".message-scroll")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(expandedMessageHeight).toBeGreaterThanOrEqual(120);
  await expectChildrenContained(desktopSidebar.locator(".sidebar-contents"));
  const shortSidebarRows = await desktopSidebar.evaluate((sidebar) => {
    const navigation = sidebar.querySelector(".conversation-navigation");
    const footer = sidebar.querySelector(".sidebar-footer");
    const current = sidebar.querySelector(".current-conversation-row");
    const action = current?.querySelector(".conversation-action-trigger");
    if (!navigation || !footer || !current || !action) {
      throw new Error("Short sidebar geometry is unavailable.");
    }
    return {
      actionBottom: action.getBoundingClientRect().bottom,
      actionHeight: action.getBoundingClientRect().height,
      footerTop: footer.getBoundingClientRect().top,
      navigationBottom: navigation.getBoundingClientRect().bottom,
      navigationOverflow: getComputedStyle(navigation).overflowY,
    };
  });
  expect(shortSidebarRows.navigationOverflow).toBe("auto");
  expect(shortSidebarRows.navigationBottom).toBeLessThanOrEqual(shortSidebarRows.footerTop + 1);
  expect(shortSidebarRows.actionHeight).toBeGreaterThanOrEqual(44);
  expect(shortSidebarRows.actionBottom).toBeLessThanOrEqual(shortSidebarRows.navigationBottom + 1);
  const shortActionTrigger = desktopSidebar.getByRole("button", { name: actionLabel });
  await desktopSidebar.locator(".conversation-navigation").evaluate((navigation) => {
    navigation.scrollTop = 0;
  });
  await shortActionTrigger.click();
  await expect(disclosure).toBeVisible();
  const shortDisclosure = await desktopSidebar.evaluate((sidebar) => {
    const navigation = sidebar.querySelector(".conversation-navigation");
    const panel = sidebar.querySelector(".conversation-action-panel");
    if (!navigation || !panel) throw new Error("Short action geometry is unavailable.");
    return {
      navigationBottom: navigation.getBoundingClientRect().bottom,
      navigationTop: navigation.getBoundingClientRect().top,
      panelBottom: panel.getBoundingClientRect().bottom,
      panelTop: panel.getBoundingClientRect().top,
    };
  });
  expect(shortDisclosure.panelTop).toBeGreaterThanOrEqual(shortDisclosure.navigationTop - 1);
  expect(shortDisclosure.panelBottom).toBeLessThanOrEqual(shortDisclosure.navigationBottom + 1);
  await page.keyboard.press("Escape");
  await expect(shortActionTrigger).toBeFocused();
  await expectViewportContained(page);

  await page.goto(`/c/${fixture.archivedId}`);
  await expect(page.getByRole("article", { name: fixture.archivedTitle })).toBeFocused();
  const archivedAction = page.getByRole("button", {
    name: copy.conversations.conversation.actionsLabel(fixture.archivedTitle),
  });
  await archivedAction.click();
  await expect(
    page.getByRole("button", { name: copy.conversations.conversation.unarchive }),
  ).toBeVisible();
  await page.getByRole("button", { name: copy.conversations.conversation.delete }).click();
  await page
    .getByRole("dialog", { name: copy.conversations.conversation.deleteTitle })
    .getByRole("button", { name: copy.conversations.conversation.confirmDelete })
    .click();
  await expect(page).toHaveURL(/\/$/u);
  const newChatComposer = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(newChatComposer).toBeFocused();
  const shortNewChatGeometry = await page.locator(".new-chat-page").evaluate((pageElement) => {
    const composer = pageElement.querySelector(".composer-control");
    const action = pageElement.querySelector(".composer-action");
    const trigger = pageElement.querySelector(".model-tier-trigger");
    const symbol = pageElement.querySelector(".new-chat-symbol");
    if (!composer || !action || !trigger || !symbol) {
      throw new Error("Short new-chat geometry is unavailable.");
    }
    const viewportHeight = document.documentElement.clientHeight;
    return {
      actionBottom: action.getBoundingClientRect().bottom,
      clientHeight: pageElement.clientHeight,
      composerTop: composer.getBoundingClientRect().top,
      scrollHeight: pageElement.scrollHeight,
      symbolDisplay: getComputedStyle(symbol).display,
      triggerBottom: trigger.getBoundingClientRect().bottom,
      viewportHeight,
    };
  });
  expect(shortNewChatGeometry.symbolDisplay).toBe("none");
  expect(shortNewChatGeometry.composerTop).toBeGreaterThanOrEqual(0);
  expect(shortNewChatGeometry.triggerBottom).toBeLessThanOrEqual(
    shortNewChatGeometry.viewportHeight,
  );
  expect(shortNewChatGeometry.actionBottom).toBeLessThanOrEqual(
    shortNewChatGeometry.viewportHeight,
  );
  expect(shortNewChatGeometry.scrollHeight).toBeLessThanOrEqual(
    shortNewChatGeometry.clientHeight + 1,
  );
  await tier.click();
  await expect(tierPopover).toBeVisible();
  const shortPopoverBox = await tierPopover.boundingBox();
  const shortViewport = page.viewportSize();
  expect(shortPopoverBox).not.toBeNull();
  expect(shortPopoverBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (shortPopoverBox?.y ?? 0) + (shortPopoverBox?.height ?? Number.POSITIVE_INFINITY),
  ).toBeLessThanOrEqual((shortViewport?.height ?? 0) + 1);
  expect(shortPopoverBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (shortPopoverBox?.x ?? 0) + (shortPopoverBox?.width ?? Number.POSITIVE_INFINITY),
  ).toBeLessThanOrEqual((shortViewport?.width ?? 0) + 1);
  await expectPopoverWithinClipRoot(page, ".conversation-route");
  await page.keyboard.press("Escape");
  await expect(tierPopover).toHaveCount(0);
  await page.setViewportSize({ width: 1_280, height: 720 });
  const newChatGeometry = await page.locator(".new-chat-page").evaluate((pageElement) => {
    const textarea = pageElement.querySelector("textarea");
    const composer = pageElement.querySelector(".composer-control");
    if (!textarea || !composer) {
      throw new Error("New-chat composer geometry is unavailable.");
    }
    const textareaBox = textarea.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return {
      alignContent: getComputedStyle(pageElement).alignContent,
      composerBottom: composerBox.bottom,
      composerTop: composerBox.top,
      minTextareaHeight: Number.parseFloat(getComputedStyle(textarea).minHeight),
      textareaHeight: textareaBox.height,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(newChatGeometry.alignContent).toContain("center");
  expect(newChatGeometry.textareaHeight).toBeCloseTo(newChatGeometry.minTextareaHeight, 0);
  expect(newChatGeometry.composerTop).toBeGreaterThan(newChatGeometry.viewportHeight * 0.35);
  expect(newChatGeometry.composerBottom).toBeLessThan(newChatGeometry.viewportHeight * 0.8);
  await expectViewportContained(page);
});
