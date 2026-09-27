/**
 * Dismiss unsolicited modal dialogs (promos, announcements) that block the
 * notebook UI.
 *
 * Google mounts these on page load — e.g. the Gemini Notebook rebrand's
 * `<accessibility-promo-dialog>` — and their CDK backdrop intercepts every
 * pointer event, so clicking the chat input times out even though the input
 * itself is visible. We close whatever is open (close button first, Escape
 * as a fallback) and log the dialog's component tag so new variants are easy
 * to spot in the server log.
 */

import type { Page } from "patchright";
import { Selectors, joinAlt } from "./selectors.js";
import { log } from "../utils/logger.js";

const MAX_ATTEMPTS = 3;

/**
 * Close every blocking modal on `page`.
 *
 * @returns true when no blocking backdrop remains.
 */
export async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const backdrop = page.locator(Selectors.dialogs.backdrop).first();
  const isBlocked = () => backdrop.isVisible().catch(() => false);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!(await isBlocked())) {
      return true;
    }

    const component = await page
      .locator(Selectors.dialogs.componentHost)
      .first()
      .evaluate((el) => el.tagName.toLowerCase())
      .catch(() => "unknown");
    log.warning(`  ⚠️  Blocking dialog <${component}> detected, dismissing…`);

    const closeButton = page.locator(joinAlt(Selectors.dialogs.closeButton)).first();
    const clicked = await closeButton
      .click({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    await backdrop.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
    // The dialog pane outlives the backdrop during its close animation;
    // callers that look for `[role="dialog"]` next would otherwise grab it.
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "hidden", timeout: 3_000 })
      .catch(() => undefined);
  }

  if (await isBlocked()) {
    log.error("  ❌ Could not dismiss blocking dialog — clicks on the notebook will fail");
    return false;
  }
  return true;
}
