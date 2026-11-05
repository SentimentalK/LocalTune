import { expect, test } from '@playwright/test';
import de from '../src/i18n/de.js';
import en from '../src/i18n/en.js';
import fr from '../src/i18n/fr.js';
import ko from '../src/i18n/ko.js';
import zhCN from '../src/i18n/zh-CN.js';

// Every test starts from the browser locale, so the stored setting is `auto`.
test.use({ locale: 'fr-FR' });

async function openSettings(page) {
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-language"]')).toBeVisible();
}

function hasNoHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

/**
 * Replaces the read-only browser language list with a writable one and exposes
 * `window.__setBrowserLanguages`, which also fires the real `languagechange`.
 */
function installLanguageSetter(page, initial) {
  return page.addInitScript((languages) => {
    let current = languages;
    const define = () => {
      Object.defineProperty(navigator, 'languages', {
        configurable: true,
        get: () => current,
      });
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        get: () => current[0],
      });
    };
    define();
    window.__setBrowserLanguages = (next) => {
      current = next;
      define();
      window.dispatchEvent(new Event('languagechange'));
    };
  }, initial);
}

test('auto follows the browser locale on a 360px phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await openSettings(page);

  const rows = page.locator('[data-testid^="language-"]');
  await expect(rows).toHaveCount(11);
  await expect(
    page.locator('[data-testid^="language-"]:not([data-testid="language-auto"])'),
  ).toHaveCount(10);

  const auto = page.locator('[data-testid="language-auto"]');
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await expect(auto).toContainText('Français');

  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
  await page.locator('[data-testid="settings-section-language"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/language-360.png' });

  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toHaveText(fr['tabs.folders']);
});

test('picking Korean loads its chunk and applies immediately', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await openSettings(page);

  await page.locator('[data-testid="language-ko"]').click();
  await expect(page.locator('[data-testid="language-ko"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('[data-testid="language-auto"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe('ko');

  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toHaveText(ko['tabs.folders']);

  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
  await page.locator('[data-testid="settings-section-language"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/language-390.png' });
});

test('languagechange moves the auto setting without a reload', async ({ page }) => {
  await installLanguageSetter(page, ['fr-FR']);
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe('fr');
  await expect(page.locator('#tab-folders')).toHaveText(fr['tabs.folders']);

  await page.evaluate(() => window.__setBrowserLanguages(['de-DE']));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe('de');
  await expect(page.locator('#tab-folders')).toHaveText(de['tabs.folders']);
});

test('an explicit pick ignores later languagechange', async ({ page }) => {
  await installLanguageSetter(page, ['fr-FR']);
  await page.goto('/');
  await openSettings(page);

  await page.locator('[data-testid="language-ko"]').click();
  await expect(page.locator('[data-testid="language-ko"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.evaluate(() => window.__setBrowserLanguages(['es-ES']));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');

  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toHaveText(ko['tabs.folders']);
});

/**
 * Chrome's UI language and its content preferences are separate: this stubs
 * `navigator.language` (UI) and `navigator.languages` (preferences) with
 * different values, which a real browser only does for some users.
 */
function installBrowserLanguage(page, { language, languages }) {
  return page.addInitScript((input) => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      get: () => input.language,
    });
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => input.languages,
    });
  }, { language, languages });
}

test('the English UI language beats Chinese content preferences', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await installBrowserLanguage(page, {
    language: 'en-US',
    languages: ['zh-CN', 'en-US', 'fr-FR'],
  });
  await page.goto('/');

  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe('en');
  await expect(page.locator('#tab-folders')).toHaveText(en['tabs.folders']);

  await openSettings(page);
  await expect(page.locator('[data-testid="language-auto"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('[data-testid="browser-language-hint"]')).toHaveText(
    'Browser: en-US · zh-CN · fr-FR',
  );
  expect(await hasNoHorizontalOverflow(page)).toBe(true);

  // An explicit pick still wins over the browser.
  await page.locator('[data-testid="language-zh-CN"]').click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe('zh-CN');
  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toHaveText(zhCN['tabs.folders']);
});
