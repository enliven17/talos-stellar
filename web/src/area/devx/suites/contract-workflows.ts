import { BenchmarkOptions } from "../runner";
import { loadConfig } from "../config";

const config = loadConfig({ runs: 50, warmupRuns: 5 });

function simulateStellarAddressValidation(addresses: string[]): number {
  let valid = 0;
  for (const addr of addresses) {
    if (/^G[A-Z2-7]{55}$/.test(addr)) valid++;
  }
  return valid;
}

function simulateKeypairGeneration(count: number): { publicKey: string }[] {
  const keys: { publicKey: string }[] = [];
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  for (let i = 0; i < count; i++) {
    let key = "G";
    for (let j = 0; j < 55; j++) {
      key += chars[Math.floor(Math.random() * 32)];
    }
    keys.push({ publicKey: key });
  }
  return keys;
}

function simulateTransferPayloadSigning(count: number): string[] {
  const signatures: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = Array.from({ length: 64 }, () =>
      "0123456789abcdef"[Math.floor(Math.random() * 16)]
    ).join("");
    signatures.push(hex);
  }
  return signatures;
}

function simulateContractCallEncoding(contractId: string, method: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({
    contractId,
    method,
    args,
    network: "testnet",
    timestamp: Date.now(),
  });
  return payload;
}

function simulateContractCallDecoding(response: string): unknown {
  return JSON.parse(response);
}

function simulateRegisterTalosName(name: string, owner: string): { success: boolean; txHash: string } {
  const txHash = Array.from({ length: 64 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)]
  ).join("");
  return { success: true, txHash };
}

function simulateBalanceQuery(accountId: string, assetCode: string): { balance: string; asset: string } {
  const balance = (Math.random() * 10000).toFixed(2);
  return { balance, asset: assetCode };
}

function simulateDividendCalculation(
  totalPool: number,
  patrons: { pulseAmount: number }[],
): { shares: number[]; totalDistributed: number } {
  const totalPulse = patrons.reduce((s, p) => s + p.pulseAmount, 0);
  const shares = patrons.map((p) => (totalPool * p.pulseAmount) / totalPulse);
  const totalDistributed = shares.reduce((s, v) => s + v, 0);
  return { shares, totalDistributed };
}

export function contractWorkflowSuite(): BenchmarkOptions[] {
  const addresses = Array.from({ length: 1000 }, () => {
    let addr = "G";
    for (let j = 0; j < 55; j++) {
      addr += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)];
    }
    return addr;
  });

  const patrons = Array.from({ length: 100 }, (_, i) => ({
    stellarPublicKey: addresses[i],
    pulseAmount: Math.floor(Math.random() * 10000) + 100,
  }));

  const contractId = "CCY5XJ3N6Y7Z8AB9CD0EF1GH2IJ3KL4MN5OP6QR7ST8UV9WX0YZ1AB2CD3EF";

  return [
    {
      label: "contract-stellar-address-validate-1000",
      fn: () => {
        simulateStellarAddressValidation(addresses);
      },
      config,
    },
    {
      label: "contract-keypair-gen-100",
      fn: () => {
        simulateKeypairGeneration(100);
      },
      config,
    },
    {
      label: "contract-transfer-sign-200",
      fn: () => {
        simulateTransferPayloadSigning(200);
      },
      config,
    },
    {
      label: "contract-call-encode",
      fn: () => {
        simulateContractCallEncoding(contractId, "is_name_available", { name: "benchmark-agent" });
      },
      config,
    },
    {
      label: "contract-call-decode",
      fn: () => {
        const response = JSON.stringify({ result: { retval: true }, error: null });
        simulateContractCallDecoding(response);
      },
      config,
    },
    {
      label: "contract-register-name",
      fn: () => {
        simulateRegisterTalosName("benchmark-agent", addresses[0]);
      },
      config,
    },
    {
      label: "contract-balance-query",
      fn: () => {
        simulateBalanceQuery(addresses[0], "USDC");
      },
      config,
    },
    {
      label: "contract-dividend-calc-100-patrons",
      fn: () => {
        simulateDividendCalculation(10000, patrons);
      },
      config,
    },
    {
      label: "contract-name-resolve-simulation",
      fn: () => {
        const names = Array.from({ length: 100 }, (_, i) => `agent-${i}`);
        const results = names.map((name) => ({
          name,
          resolved: Math.floor(Math.random() * 1000),
          onChain: Math.random() > 0.2,
        }));
        JSON.stringify(results);
      },
      config,
    },
  ];
}

export function contractWorkflowSuites(): BenchmarkOptions[] {
  return contractWorkflowSuite();
}