import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const popupUrl = pathToFileURL(path.resolve(process.cwd(), "ui/popup.html")).href;
const optionsUrl = pathToFileURL(path.resolve(process.cwd(), "ui/options.html")).href;

for (const viewport of [
  { name: "compact", width: 260, height: 420, allowVerticalScroll: true },
  { name: "narrow", width: 320, height: 480, allowVerticalScroll: true },
  { name: "standard", width: 368, height: 512, allowVerticalScroll: false },
  { name: "wide", width: 430, height: 700, allowVerticalScroll: false }
]) {
  test(`popup fits the ${viewport.name} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(popupUrl);
    await expect(page.locator(".controls")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth - innerWidth,
      vertical: document.documentElement.scrollHeight - innerHeight
    }));

    expect(overflow.horizontal).toBeLessThanOrEqual(0);
    if (!viewport.allowVerticalScroll) expect(overflow.vertical).toBeLessThanOrEqual(0);
  });
}

test("options remain usable on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(optionsUrl);
  await expect(page.locator("nav")).toBeVisible();
  await expect(page.locator("#saveButton")).toBeVisible();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(0);
});
