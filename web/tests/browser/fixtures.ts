import { test as base, type Page } from '@playwright/test';
import { injectTestWalletProvider } from './helpers/test-wallet-provider';

/**
 * Extended test fixture with test wallet provider injection.
 *
 * This fixture injects a mock Stellar wallet provider before each test,
 * allowing tests to run without real wallet extensions or private keys.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    // Inject test wallet provider before each test
    await page.addInitScript(injectTestWalletProvider);
    await use(page);
  },
});

export { expect } from '@playwright/test';
