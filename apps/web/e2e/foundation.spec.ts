import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";

test("shows the branded ready screen with an intercepted readiness response", async ({ page }) => {
  await page.route("**/api/health/ready", async (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers().accept).toBe("application/json");

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        database: "up",
      }),
    });
  });

  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("link", { name: copy.brand.homeLabel })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.foundation.ready.title }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(copy.foundation.ready.status);
});
