/**
 * Test wallet provider stub for Playwright tests.
 *
 * This script is injected into the page to mock the Stellar wallet functionality,
 * allowing tests to run without real wallet extensions or private keys.
 *
 * It overrides the @creit.tech/stellar-wallets-kit global with a test implementation
 * that always succeeds with deterministic mock data.
 */

export function injectTestWalletProvider() {
  // Mock public key for testing
  const TEST_PUBLIC_KEY = 'GTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const TEST_SIGNED_XDR = 'AAAAAgAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  // Mock StellarWalletsKit interface
  const mockStellarWalletsKit = {
    init: () => {},
    setWallet: () => {},
    getAddress: async () => ({ address: TEST_PUBLIC_KEY }),
    fetchAddress: async () => ({ address: TEST_PUBLIC_KEY }),
    disconnect: async () => {},
    signTransaction: async () => ({ signedTxXdr: TEST_SIGNED_XDR }),
    signMessage: async () => ({ signedMessage: Buffer.from('mock-signature').toString('base64') }),
  };

  // Inject into window
  (window as any).StellarWalletsKit = mockStellarWalletsKit;

  // Notify the app that wallet is ready
  window.dispatchEvent(new CustomEvent('stellar-wallet-ready', { detail: { address: TEST_PUBLIC_KEY } }));
}
