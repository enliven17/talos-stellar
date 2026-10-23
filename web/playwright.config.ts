import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for browser tests.
 *
 * These tests run against the local stack (postgres + mock-stellar) and use
 * a stubbed wallet provider to avoid real key material.
 *
 * To run:
 *   pnpm test:browser
 *
 * Prerequisites:
 *   - Local stack running: docker compose up -d postgres mock-stellar web
 *   - Database seeded: pnpm db:seed
 */
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Note: webServer is not configured here because the local stack (docker compose)
  // must be started manually. Tests assume the server is already running at baseURL.
  // To run tests:
  //   1. Start local stack: docker compose up -d postgres mock-stellar web
  //   2. Seed database: pnpm db:seed
  //   3. Run tests: pnpm test:browser
});
