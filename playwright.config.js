import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PW_PORT ?? 4173);

// WebKit is not installed in CI (the test job installs Chromium only), so the
// engine that showed the composited-layer clip bug is opt-in locally:
//   PW_WEBKIT=1 npx playwright test e2e/disc-clip.spec.js --project=webkit
const webkitProject =
  process.env.PW_WEBKIT === '1'
    ? [{ name: 'webkit', use: { ...devices['iPhone 13'] } }]
    : [];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'zh-CN',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `PORT=${PORT} node scripts/serve.mjs`,
    port: PORT,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    ...webkitProject,
  ],
});
