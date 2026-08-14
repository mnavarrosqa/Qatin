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

export class NavLabelMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavLabelMissingError';
  }
}

export function labelFromSelector(selector: string): string | null {
  const m =
    selector.match(/has-text\(['"]([^'"]+)['"]\)/i) ||
    selector.match(/^text=(.+)$/i) ||
    selector.match(/aria-label=["']([^"']+)["']/i);
  return m?.[1] ?? null;
}

const HAMBURGER_SELECTORS = [
  'button.menu-button',
  '.menu-button',
  'button:has(i.material-icons:text-is("menu"))',
  'i.material-icons:text-is("menu")',
  '.base-header button',
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
  '.mat-drawer-opened',
  'ion-menu.menu-pane-visible',
  'ion-menu.show-menu',
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
  const drawer = page.locator('.mat-drawer, mat-sidenav').first();
  return drawer.isVisible().catch(() => false);
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
    try {
      await loc.click({ timeout: HAMBURGER_OPEN_MS });
    } catch {
      await loc.click({ timeout: HAMBURGER_OPEN_MS, force: true });
    }
    await page.waitForTimeout(400);
    await page
      .locator('.title-menu, .mat-drawer.mat-drawer-opened, .mat-drawer-opened')
      .first()
      .waitFor({ state: 'visible', timeout: 3000 })
      .catch(() => undefined);
    hamburgerOpenedAt.set(page, Date.now());
    logger.info(`Opened hamburger menu via ${sel}`);
    return true;
  }

  const toolbarBtn = page.locator('.base-header button, .menu-button').first();
  if (await toolbarBtn.isVisible().catch(() => false)) {
    await toolbarBtn.click({ timeout: HAMBURGER_OPEN_MS }).catch(() =>
      toolbarBtn.click({ timeout: HAMBURGER_OPEN_MS, force: true })
    );
    await page.waitForTimeout(400);
    hamburgerOpenedAt.set(page, Date.now());
    logger.info('Opened hamburger menu via .base-header button');
    return true;
  }

  return false;
}

export async function visibleNavLabels(page: Page): Promise<string[]> {
  const items = page.locator('.title-menu');
  const n = await items.count();
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, 40); i++) {
    const item = items.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = ((await item.textContent()) || '').trim();
    if (text) out.push(text);
  }
  return out;
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
  const opened = await openHamburgerMenu(page);
  const label = labelFromSelector(selector);
  if (label) {
    const exact = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, 'i');
    const row = page
      .locator('.subtree-item, .main-item, app-navbar-item')
      .filter({ has: page.locator('.title-menu').filter({ hasText: exact }) })
      .first();
    const title = page.locator('.title-menu').filter({ hasText: exact }).first();
    const menuItem = (await row.count()) ? row : title;
    if (await waitVisible(menuItem, 2500)) {
      try {
        await menuItem.click({ timeout: clickTimeout });
      } catch {
        await menuItem.click({ timeout: clickTimeout, force: true });
      }
      return;
    }
  }
  if (await waitVisible(loc, 2500)) {
    await loc.click({ timeout: clickTimeout });
    return;
  }
  const visible = opened ? await visibleNavLabels(page) : [];
  throw new NavLabelMissingError(
    `No se encontró el control (${selector}) en pantalla ni en el menú hamburguesa.` +
      (visible.length
        ? ` Ítems visibles del menú: ${visible.slice(0, 20).join(', ')}.`
        : opened
          ? ' El menú se abrió pero el label no está.'
          : ' No se pudo abrir el menú hamburguesa.')
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
