import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PW_PORT ?? 4173);

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
  ],
});
