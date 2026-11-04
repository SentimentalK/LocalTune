// APP-001-M: the installed PWA hands the Microsoft redirect to a new browsing
// context (Android Custom Tab), where sessionStorage is empty. A second tab in
// the same browser profile shares IndexedDB but not sessionStorage.
import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

async function holdAuthorize(page) {
  await page.route('https://login.microsoftonline.com/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/token')) return route.fallback();
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><title>login</title>',
    });
  });
}

test('a redirect caught by a new browsing context completes and opens the picker', async ({ context, page }) => {
  await installGraphMock(page, { files: FILES });
  await holdAuthorize(page);

  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-source-add"]').click();

  const authorize = page.waitForRequest((request) =>
    request.url().startsWith('https://login.microsoftonline.com/'),
  );
  await page.locator('[data-testid="settings-source-onedrive"]').click();
  const state = new URL((await authorize).url()).searchParams.get('state');
  expect(state).toBeTruthy();

  const returned = await context.newPage();
  await installGraphMock(returned, { files: FILES });
  await returned.goto(`/?code=mock-code&state=${encodeURIComponent(state)}`);

  await expect(returned.locator('[data-testid="settings-section-library"]')).toBeVisible();
  await expect(returned.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(returned.locator('[data-testid="settings-onedrive-hint"]')).toBeVisible();
  await expect(returned.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
});

test('a mismatched state shows the cloud account error and never exchanges the code', async ({ context }) => {
  const returned = await context.newPage();
  const mock = await installGraphMock(returned, { files: FILES });
  await returned.goto('/?code=mock-code&state=not-the-stored-state');

  await expect(returned.locator('[data-testid="settings-section-library"]')).toBeVisible();
  await expect(returned.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  const error = returned.locator('[data-testid="source-row-onedrive"] .settings-error');
  await expect(error).toBeVisible();
  await expect(error).not.toHaveText('');
  await expect(returned.locator('[data-testid="settings-onedrive-retry"]')).toBeVisible();
  expect(mock.tokenRequests ?? []).toHaveLength(0);
});
