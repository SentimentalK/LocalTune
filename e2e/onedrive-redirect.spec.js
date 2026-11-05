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

  const authorize = page.waitForRequest((request) =>
    request.url().startsWith('https://login.microsoftonline.com/'),
  );
  await page.locator('[data-testid="source-connect-onedrive"]').click();
  const state = new URL((await authorize).url()).searchParams.get('state');
  expect(state).toBeTruthy();

  const returned = await context.newPage();
  await installGraphMock(returned, { files: FILES });
  await returned.goto(`/?code=mock-code&state=${encodeURIComponent(state)}`);

  await expect(returned.locator('[data-testid="settings-section-library"]')).toBeVisible();
  await expect(returned.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(returned.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
});

test('two documents loading the same redirect exchange the code once', async ({ context, page }) => {
  await installGraphMock(page, { files: FILES });
  await holdAuthorize(page);

  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();

  const authorize = page.waitForRequest((request) =>
    request.url().startsWith('https://login.microsoftonline.com/'),
  );
  await page.locator('[data-testid="source-connect-onedrive"]').click();
  const state = new URL((await authorize).url()).searchParams.get('state');
  expect(state).toBeTruthy();

  const redirect = `/?code=mock-code&state=${encodeURIComponent(state)}`;

  let markTokenSeen;
  const tokenSeen = new Promise((resolve) => {
    markTokenSeen = resolve;
  });
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  const doc1 = await context.newPage();
  const doc1Mock = await installGraphMock(doc1, { files: FILES });
  await doc1.route('https://login.microsoftonline.com/**', async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith('/token')) return route.fallback();
    markTokenSeen();
    await gate;
    return route.fallback();
  });
  await doc1.goto(redirect);
  await tokenSeen;

  const doc2 = await context.newPage();
  const doc2Mock = await installGraphMock(doc2, { files: FILES });
  await doc2.goto(redirect);
  await doc2.waitForTimeout(300);
  releaseGate();

  await expect(doc1.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(doc2.locator('[data-testid="settings-section-library"]')).toBeVisible();
  await expect(doc2.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  expect(doc1Mock.tokenRequests).toHaveLength(1);
  expect(doc2Mock.tokenRequests).toHaveLength(0);
  await expect(doc1.locator('[data-testid="source-row-onedrive"] .settings-error')).toBeHidden();
  await expect(doc2.locator('[data-testid="source-row-onedrive"] .settings-error')).toBeHidden();
});

test('a mismatched state shows the cloud account error and never exchanges the code', async ({ context }) => {
  const returned = await context.newPage();
  const mock = await installGraphMock(returned, { files: FILES });
  await returned.goto('/?code=mock-code&state=not-the-stored-state');

  await expect(returned.locator('[data-testid="settings-section-library"]')).toBeVisible();
  await expect(returned.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  const error = returned.locator('[data-testid="source-row-onedrive"] .settings-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveText('OneDrive 登录状态丢失，请重试');
  await expect(returned.locator('[data-testid="source-connect-onedrive"]')).toBeEnabled();
  expect(mock.tokenRequests ?? []).toHaveLength(0);
});
