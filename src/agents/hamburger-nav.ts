import type { Locator, Page } from 'playwright';
import { logger } from '../utils/logger';

export const HAMBURGER_PROBE_MS = 1500;
export const HAMBURGER_OPEN_MS = 5000;
export const CLICK_AFTER_NAV_MS = 8000;

/** Explicit "open the hamburger / sidenav" steps — not a click on a quoted feature label. */
export function isHamburgerStep(step: string): boolean {
  const t = step.toLowerCase();
  if (/['"][^'"]+['"]/.test(step) && !/hamburguesa|\bhamburger\b/.test(t)) {
    return false;
  }
  return (
    /hamburguesa|\bhamburger\b/.test(t) ||
    /men[uú]\s+(lateral|principal|de\s+navegaci)/.test(t) ||
    /icono\s+(del\s+)?men[uú]/.test(t) ||
    /\bsidenav\b|\bdrawer\b/.test(t) ||
    /abrir\s+(el\s+)?men[uú]/.test(t)
  );
}

/**
 * Prefer scenario selectors that mention the quoted label in the step,
 * so self-heal does not burn 30s on unrelated candidates (e.g. Dashboard
 * while clicking F12).
 */
export function selectorsMatchingQuotedLabel(
  step: string,
  scenarioSelectors: string[]
): string[] {
  const quoted = step.match(/['"]([^'"]+)['"]/)?.[1];
  if (!quoted || !scenarioSelectors.length) return scenarioSelectors;
  const q = quoted.toLowerCase();
  const hits = scenarioSelectors.filter((s) => s.toLowerCase().includes(q));
  return hits.length ? hits : scenarioSelectors;
}

const HAMBURGER_SELECTORS = [
  'button:has(mat-icon:text-is("menu"))',
  'button:has(mat-icon:has-text("menu"))',
  'button:has(ion-icon[name="menu"])',
  'ion-menu-button',
  'button[aria-label*="menu" i]',
  'button[aria-label*="menú" i]',
  'button[aria-label*="naveg" i]',
  'button.navbar-toggler',
  '[class*="hamburger" i]',
  'button:has([class*="hamburger" i])',
  'mat-icon:text-is("menu")',
];

const DRAWER_SELECTORS = [
  'mat-sidenav.mat-drawer-opened',
  '.mat-drawer.mat-drawer-opened',
  'mat-sidenav:not(.mat-drawer-closed)',
  '[role="navigation"]',
  'aside[class*="sidenav" i]',
  '.mat-mdc-sidenav',
  'ion-menu.menu-pane-visible',
  'ion-menu.show-menu',
  '[class*="sidenav"][class*="open" i]',
];

async function waitVisible(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

export async function isNavDrawerOpen(page: Page): Promise<boolean> {
  for (const sel of DRAWER_SELECTORS) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

/** Avoid toggling the same page's hamburger closed during self-heal retries. */
const hamburgerOpenedAt = new WeakMap<Page, number>();
const HAMBURGER_REOPEN_GUARD_MS = 8000;

export async function openHamburgerMenu(page: Page): Promise<boolean> {
  if (await isNavDrawerOpen(page)) return true;
  const openedAt = hamburgerOpenedAt.get(page) || 0;
  if (openedAt && Date.now() - openedAt < HAMBURGER_REOPEN_GUARD_MS) {
    return true;
  }

  for (const sel of HAMBURGER_SELECTORS) {
    const loc = page.locator(sel).first();
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: HAMBURGER_OPEN_MS });
    await page.waitForTimeout(350);
    hamburgerOpenedAt.set(page, Date.now());
    logger.info(`Opened hamburger menu via ${sel}`);
    return true;
  }

  const toolbarBtn = page
    .locator(
      'header button, mat-toolbar button, .mat-toolbar button, [role="banner"] button'
    )
    .first();
  if (await toolbarBtn.isVisible().catch(() => false)) {
    const text = ((await toolbarBtn.innerText().catch(() => '')) || '').trim();
    if (text.length <= 8) {
      await toolbarBtn.click({ timeout: HAMBURGER_OPEN_MS });
      await page.waitForTimeout(350);
      hamburgerOpenedAt.set(page, Date.now());
      logger.info('Opened hamburger menu via first toolbar icon button');
      return true;
    }
  }

  return false;
}

/** If the quoted/target locator is hidden, open the hamburger/sidenav first. */
export async function revealViaHamburger(
  page: Page,
  locator: Locator
): Promise<boolean> {
  if (await locator.first().isVisible().catch(() => false)) return true;
  const opened = await openHamburgerMenu(page);
  if (!opened) return false;
  return waitVisible(locator, HAMBURGER_OPEN_MS);
}

export async function clickViaHamburger(
  page: Page,
  selector: string,
  clickTimeout = CLICK_AFTER_NAV_MS
): Promise<void> {
  const loc = page.locator(selector).first();
  if (await waitVisible(loc, HAMBURGER_PROBE_MS)) {
    await loc.click({ timeout: clickTimeout });
    return;
  }
  logger.info(`Target not on screen (${selector}); opening hamburger menu`);
  await openHamburgerMenu(page);
  await loc.click({ timeout: clickTimeout });
}
