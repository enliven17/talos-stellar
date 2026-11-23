import raw from "./dividend_conservation.json";

export type DividendRole = "creator" | "investor" | "treasury";

export interface DividendCase {
  id: string;
  funded_amount: string;
  shares: Record<DividendRole, number>;
  claim_order: DividendRole[];
  expected_allocations: Record<DividendRole, string>;
  expected_claimed_amount: string;
  expected_rounding_dust: string;
}

export interface DividendFixtureSet {
  spec_version: string;
  format: string;
  rounding: "floor";
  roles: DividendRole[];
  cases: DividendCase[];
}

export const dividendFixtures = raw as DividendFixtureSet;

export function calculateLiabilities(testCase: DividendCase): {
  allocations: Record<DividendRole, bigint>;
  claimed: bigint;
  roundingDust: bigint;
} {
  const funded = BigInt(testCase.funded_amount);
  const allocations = {} as Record<DividendRole, bigint>;
  let claimed = 0n;

  for (const role of testCase.claim_order) {
    const allocation = (funded * BigInt(testCase.shares[role])) / 100n;
    allocations[role] = allocation;
    claimed += allocation;
  }

  return {
    allocations,
    claimed,
    roundingDust: funded - claimed,
  };
}
