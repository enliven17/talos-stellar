/**
 * Soroban contract interaction — replaces contracts.ts (Hedera/ethers).
 *
 * Handles TalosRegistry and TalosNameService on Stellar Soroban.
 * Read-only calls use Soroban RPC directly.
 * Write calls (create TALOS, register name) go through the user's wallet via WalletKit.
 */

// NEXT_PUBLIC_ prefix required — soroban.ts is imported by client components (launch/page.tsx)
const STELLAR_NETWORK =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? process.env.STELLAR_NETWORK ?? "testnet";
const STELLAR_SOROBAN_RPC =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ??
  process.env.STELLAR_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const TALOS_REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT ?? "";

export const TALOS_NAME_SERVICE_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT ?? "";

export const TALOS_GOVERNANCE_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT ?? "";

export const TALOS_DIVIDENDS_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_DIVIDENDS_CONTRACT ?? "";

let DUMMY_ACCOUNT_PUBLIC: string | null = null;

async function getDummyAccountPublicKey(): Promise<string> {
  if (!DUMMY_ACCOUNT_PUBLIC) {
    const { Keypair } = await import("@stellar/stellar-sdk");
    DUMMY_ACCOUNT_PUBLIC = Keypair.random().publicKey();
  }
  return DUMMY_ACCOUNT_PUBLIC;
}

export const TALOS_DIVIDENDS_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_DIVIDENDS_CONTRACT ?? "";

export const STELLAR_TESTNET = {
  networkPassphrase: "Test SDF Network ; September 2015",
  sorobanRpc: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
};

export const STELLAR_MAINNET = {
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  sorobanRpc: "https://soroban-rpc.stellar.org",
  horizonUrl: "https://horizon.stellar.org",
};

export function getNetwork() {
  return STELLAR_NETWORK === "mainnet" ? STELLAR_MAINNET : STELLAR_TESTNET;
}

/**
 * Get a Soroban RPC client for read-only queries.
 */
export async function getSorobanClient() {
  const { rpc } = await import("@stellar/stellar-sdk");
  return new rpc.Server(STELLAR_SOROBAN_RPC);
}

export interface DividendEpoch {
  epochId: bigint;
  talosId: number;
  totalAmount: bigint;
  claimedAmount: bigint;
  createdAt: bigint;
  expirySecs: bigint;
}

export interface TalosPatronDetails {
  creatorAddress: string;
  investorAddress: string;
  treasuryAddress: string;
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
}

function requireDividendsContractId(): string {
  if (!TALOS_DIVIDENDS_CONTRACT_ID) {
    throw new Error("Dividend claims are not configured for this network.");
  }
  return TALOS_DIVIDENDS_CONTRACT_ID;
}

function requireRegistryContractId(): string {
  if (!TALOS_REGISTRY_CONTRACT_ID) {
    throw new Error("The Talos registry contract is not configured for this network.");
  }
  return TALOS_REGISTRY_CONTRACT_ID;
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Invalid ${field} returned by the dividends contract.`);
}

function readEpochField(record: unknown, field: string): unknown {
  if (record instanceof Map) return record.get(field);
  if (typeof record === "object" && record !== null) {
    return (record as Record<string, unknown>)[field];
  }
  throw new Error("Invalid contract record data.");
}

async function readContract(
  contractId: string,
  method: string,
  args: import("@stellar/stellar-sdk").xdr.ScVal[],
): Promise<unknown> {
  const { Contract, scValToNative } = await import("@stellar/stellar-sdk");
  const server = await getSorobanClient();
  const contract = new Contract(contractId);
  const result = await server.simulateTransaction(
    await buildReadOnlyTx(contract.call(method, ...args)),
  );

  if ("error" in result) {
    throw new Error(`Dividends contract read failed: ${result.error}`);
  }
  return scValToNative(
    (result as { result: { retval: import("@stellar/stellar-sdk").xdr.ScVal } })
      .result.retval,
  );
}

async function readDividendsContract(
  method: string,
  args: import("@stellar/stellar-sdk").xdr.ScVal[],
): Promise<unknown> {
  return readContract(requireDividendsContractId(), method, args);
}

/** Read the canonical role addresses and share percentages from TalosRegistry. */
export async function getTalosPatron(
  talosId: number,
): Promise<TalosPatronDetails | null> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const talos = await readContract(requireRegistryContractId(), "get_talos", [
    nativeToScVal(talosId, { type: "u32" }),
  ]);
  if (talos === null || talos === undefined) return null;

  const patron = readEpochField(talos, "patron");
  const readAddress = (field: string): string => {
    const value = readEpochField(patron, field);
    if (typeof value !== "string") {
      throw new Error(`Invalid ${field} returned by the Talos registry.`);
    }
    return value;
  };
  const readShare = (field: string): number => {
    const value = toBigInt(readEpochField(patron, field), field);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Invalid ${field} returned by the Talos registry.`);
    }
    return Number(value);
  };

  return {
    creatorAddress: readAddress("creator_addr"),
    investorAddress: readAddress("investor_addr"),
    treasuryAddress: readAddress("treasury_addr"),
    creatorShare: readShare("creator_share"),
    investorShare: readShare("investor_share"),
    treasuryShare: readShare("treasury_share"),
  };
}

/** Read one committed dividend epoch from the TalosDividends contract. */
export async function getEpoch(
  talosId: number,
  epochId: bigint | number,
): Promise<DividendEpoch | null> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const value = await readDividendsContract("get_epoch", [
    nativeToScVal(talosId, { type: "u32" }),
    nativeToScVal(BigInt(epochId), { type: "u64" }),
  ]);
  if (value === null || value === undefined) return null;

  return {
    epochId: toBigInt(readEpochField(value, "epoch_id"), "epoch ID"),
    talosId: Number(toBigInt(readEpochField(value, "talos_id"), "Talos ID")),
    totalAmount: toBigInt(readEpochField(value, "total_amount"), "total amount"),
    claimedAmount: toBigInt(readEpochField(value, "claimed_amount"), "claimed amount"),
    createdAt: toBigInt(readEpochField(value, "created_at"), "creation time"),
    expirySecs: toBigInt(readEpochField(value, "expiry_secs"), "expiry"),
  };
}

/** Read the next sequential epoch ID that would be assigned to a Talos. */
export async function getNextEpochId(talosId: number): Promise<bigint> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const value = await readDividendsContract("next_epoch_id", [
    nativeToScVal(talosId, { type: "u32" }),
  ]);
  return toBigInt(value, "next epoch ID");
}

/** Check whether a wallet has claimed one specific dividend epoch. */
export async function hasClaimed(
  epochId: bigint | number,
  claimant: string,
): Promise<boolean> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const value = await readDividendsContract("has_claimed", [
    nativeToScVal(BigInt(epochId), { type: "u64" }),
    nativeToScVal(claimant, { type: "address" }),
  ]);
  if (typeof value !== "boolean") {
    throw new Error("Invalid claim status returned by the dividends contract.");
  }
  return value;
}

export interface DividendClaimParams {
  claimant: string;
  talosId: number;
  epochId: bigint;
  patronCreator: string;
  patronInvestor: string;
  patronTreasury: string;
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
}

export function getDividendClaimErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = message.match(/Error\(Contract,\s*#(\d+)\)/i);
  const code = codeMatch?.[1];
  if (/AlreadyClaimed/i.test(message) || code === "5") {
    return "You have already claimed this dividend epoch.";
  }
  if (/EpochExpired/i.test(message) || code === "6") {
    return "This dividend epoch has expired and can no longer be claimed.";
  }
  if (/NotAPatron/i.test(message) || code === "10") {
    return "Your connected wallet is not registered as a patron for this TALOS.";
  }
  return message || "The dividend claim could not be completed.";
}

/**
 * Simulate, wallet-sign, and submit a dividend claim. No signing keys leave the wallet.
 */
export async function submitDividendClaim(
  params: DividendClaimParams,
  signTransaction: (xdr: string) => Promise<string>,
): Promise<string> {
  const { Account, BASE_FEE, Contract, TransactionBuilder, nativeToScVal } =
    await import("@stellar/stellar-sdk");
  const network = getNetwork();
  const server = await getSorobanClient();
  const accountResponse = await server.getAccount(params.claimant);
  const contract = new Contract(requireDividendsContractId());
  const tx = new TransactionBuilder(
    new Account(accountResponse.accountId(), accountResponse.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: network.networkPassphrase },
  )
    .addOperation(
      contract.call(
        "claim_dividend",
        nativeToScVal(params.claimant, { type: "address" }),
        nativeToScVal(params.talosId, { type: "u32" }),
        nativeToScVal(params.epochId, { type: "u64" }),
        nativeToScVal(params.patronCreator, { type: "address" }),
        nativeToScVal(params.patronInvestor, { type: "address" }),
        nativeToScVal(params.patronTreasury, { type: "address" }),
        nativeToScVal(params.creatorShare, { type: "u32" }),
        nativeToScVal(params.investorShare, { type: "u32" }),
        nativeToScVal(params.treasuryShare, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  const signedXdr = await signTransaction(preparedTx.toXDR());
  const submitted = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase),
  );
  if (submitted.status === "ERROR") {
    throw new Error(getDividendClaimErrorMessage(submitted.errorResult ?? "Transaction rejected."));
  }

  let result = await server.getTransaction(submitted.hash);
  for (let attempt = 0; attempt < 10 && result.status === "NOT_FOUND"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await server.getTransaction(submitted.hash);
  }
  if (result.status === "SUCCESS") return submitted.hash;
  if (result.status === "FAILED") {
    throw new Error(getDividendClaimErrorMessage(JSON.stringify(result)));
  }
  throw new Error(`Claim submitted but confirmation is pending. Transaction: ${submitted.hash}`);
}

/**
 * Check if a name is available on-chain via the TalosNameService contract.
 * Read-only — no wallet needed.
 */
export async function isNameAvailableOnChain(name: string): Promise<boolean> {
  if (!TALOS_NAME_SERVICE_CONTRACT_ID) return true; // Fallback: format validation only

  try {
    const { Contract, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
    const server = await getSorobanClient();

    const contract = new Contract(TALOS_NAME_SERVICE_CONTRACT_ID);
    const result = await server.simulateTransaction(
      await buildReadOnlyTx(
        contract.call("is_name_available", nativeToScVal(name, { type: "string" })),
      ),
    );

    if ("error" in result) return true;
    return scValToNative((result as { result: { retval: import("@stellar/stellar-sdk").xdr.ScVal } }).result.retval) as boolean;
  } catch {
    // Contract not deployed yet — fall back to regex validation
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && !/--/.test(name);
  }
}

/**
 * Resolve a .talos name to its on-chain TALOS ID.
 * Returns null if name is not registered.
 */
export async function resolveNameOnChain(name: string): Promise<number | null> {
  if (!TALOS_NAME_SERVICE_CONTRACT_ID) return null;

  try {
    const { Contract, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
    const server = await getSorobanClient();

    const contract = new Contract(TALOS_NAME_SERVICE_CONTRACT_ID);
    const result = await server.simulateTransaction(
      await buildReadOnlyTx(
        contract.call("resolve_name", nativeToScVal(name, { type: "string" })),
      ),
    );

    if ("error" in result) return null;
    const id = scValToNative((result as { result: { retval: import("@stellar/stellar-sdk").xdr.ScVal } }).result.retval) as number;
    return id > 0 ? id : null;
  } catch {
    return null;
  }
}

// ─── Governance (read-only) ──────────────────────────────────────────────────
//
// Reads of the TalosGovernance contract for the proposal detail page. Like the
// helpers above they simulate a call with a dummy account, so no wallet is
// needed and nothing is ever signed or submitted. Every helper reports a
// discriminated result instead of throwing: the page can tell "no contract is
// configured" from "no such proposal" from "the RPC could not be reached", and
// a network failure never takes the page down.

/** The TalosGovernance contract, set per deployment. Empty when not configured. */
export function getGovernanceContractId(): string {
  return process.env.NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT ?? "";
}

export type GovernanceRead<T> =
  | { status: "ok"; data: T }
  | { status: "not-configured" }
  | { status: "not-found" }
  | { status: "unavailable" };

export type OnChainProposalStatus = "Active" | "Approved" | "Rejected" | "Executed";

/** `Proposal` as the contract stores it. Voting weights are i128, so strings. */
export interface OnChainProposal {
  id: number;
  talosId: number;
  proposer: string;
  title: string;
  description: string;
  snapshotLedger: number;
  startLedger: number;
  endLedger: number;
  status: OnChainProposalStatus;
  yesVotes: string;
  noVotes: string;
  totalVoters: number;
  /** Unix seconds. */
  createdAt: number;
}

/** `ProposalQuorumState` as `get_proposal_quorum_state` returns it. */
export interface OnChainQuorumState {
  votesCast: string;
  quorumThreshold: string;
  quorumMet: boolean;
  yesVotes: string;
  noVotes: string;
  /** Yes share of the votes cast, in basis points (10 000 is 100 %). */
  approvalBps: number;
  /** The approval share needed to pass, in basis points. */
  consensusThreshold: number;
  /** Progress toward quorum in basis points, capped at 10 000. */
  quorumFractionBps: number;
}

/** One `vote` event the contract emitted. */
export interface OnChainVote {
  voter: string;
  choice: "Approve" | "Reject";
  weight: string;
  txHash: string;
  ledger: number;
  /** ISO 8601 close time of the ledger the vote was cast in. */
  closedAt: string;
}

export interface OnChainVotePage {
  votes: OnChainVote[];
  /** Pass back as `cursor` for the next page; `null` on the last page. */
  nextCursor: string | null;
  /** The oldest ledger the RPC still serves events for. */
  oldestLedger: number;
  latestLedger: number;
}

const PROPOSAL_STATUSES: readonly OnChainProposalStatus[] = [
  "Active",
  "Approved",
  "Rejected",
  "Executed",
];

/** Soroban RPC keeps about a week of events (17 280 ledgers a day at 5 s). */
const EVENT_LOOKBACK_LEDGERS = 120_960;

export const VOTES_PAGE_SIZE = 20;
const MAX_VOTES_PAGE_SIZE = 100;

/** Decodes an i128/u64/u32 that the SDK returned as a bigint, number or string. */
function toBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  } catch {
    // fall through
  }
  return null;
}

function toSafeInt(value: unknown, min: number, max: number): number | null {
  const big = toBigInt(value);
  if (big === null || big < BigInt(min) || big > BigInt(max)) return null;
  return Number(big);
}

/**
 * The name of a unit variant of a `#[contracttype]` enum. The SDK decodes
 * `ProposalStatus::Active` as `["Active"]`.
 */
function variantName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a decoded `Proposal`. Returns `null` for anything that is not one,
 * so the page never renders `NaN` or `undefined` from a malformed response.
 */
export function parseOnChainProposal(native: unknown): OnChainProposal | null {
  if (!isRecord(native)) return null;
  const status = variantName(native.status);
  const yes = toBigInt(native.yes_votes);
  const no = toBigInt(native.no_votes);
  const id = toSafeInt(native.id, 0, 0xffff_ffff);
  const talosId = toSafeInt(native.talos_id, 0, 0xffff_ffff);
  const snapshotLedger = toSafeInt(native.snapshot_ledger, 0, 0xffff_ffff);
  const startLedger = toSafeInt(native.start_ledger, 0, 0xffff_ffff);
  const endLedger = toSafeInt(native.end_ledger, 0, 0xffff_ffff);
  const totalVoters = toSafeInt(native.total_voters, 0, 0xffff_ffff);
  const createdAt = toSafeInt(native.created_at, 0, Number.MAX_SAFE_INTEGER);

  if (
    !status ||
    !(PROPOSAL_STATUSES as readonly string[]).includes(status) ||
    typeof native.proposer !== "string" ||
    typeof native.title !== "string" ||
    typeof native.description !== "string" ||
    yes === null ||
    no === null ||
    id === null ||
    talosId === null ||
    snapshotLedger === null ||
    startLedger === null ||
    endLedger === null ||
    totalVoters === null ||
    createdAt === null
  ) {
    return null;
  }

  return {
    id,
    talosId,
    proposer: native.proposer,
    title: native.title,
    description: native.description,
    snapshotLedger,
    startLedger,
    endLedger,
    status: status as OnChainProposalStatus,
    yesVotes: yes.toString(),
    noVotes: no.toString(),
    totalVoters,
    createdAt,
  };
}

/** Validates a decoded `ProposalQuorumState`. */
export function parseOnChainQuorumState(native: unknown): OnChainQuorumState | null {
  if (!isRecord(native)) return null;
  const votesCast = toBigInt(native.votes_cast);
  const quorumThreshold = toBigInt(native.quorum_threshold);
  const yes = toBigInt(native.yes_votes);
  const no = toBigInt(native.no_votes);
  const approvalBps = toSafeInt(native.approval_bps, 0, 10_000);
  const consensusThreshold = toSafeInt(native.consensus_threshold, 0, 10_000);
  const quorumFractionBps = toSafeInt(native.quorum_fraction_bps, 0, 10_000);

  if (
    votesCast === null ||
    quorumThreshold === null ||
    yes === null ||
    no === null ||
    approvalBps === null ||
    consensusThreshold === null ||
    quorumFractionBps === null ||
    typeof native.quorum_met !== "boolean"
  ) {
    return null;
  }

  return {
    votesCast: votesCast.toString(),
    quorumThreshold: quorumThreshold.toString(),
    quorumMet: native.quorum_met,
    yesVotes: yes.toString(),
    noVotes: no.toString(),
    approvalBps,
    consensusThreshold,
    quorumFractionBps,
  };
}

/** Validates one `vote` event (topics `["vote", proposal_id]`, an `EventVoteCast` value). */
export function parseOnChainVoteEvent(event: {
  txHash?: unknown;
  ledger?: unknown;
  ledgerClosedAt?: unknown;
  value: unknown;
}): OnChainVote | null {
  const value = event.value;
  if (!isRecord(value)) return null;
  const choice = variantName(value.choice);
  const weight = toBigInt(value.weight);
  const ledger = toSafeInt(event.ledger, 0, 0xffff_ffff);
  if (
    typeof value.voter !== "string" ||
    (choice !== "Approve" && choice !== "Reject") ||
    weight === null ||
    ledger === null ||
    typeof event.txHash !== "string" ||
    typeof event.ledgerClosedAt !== "string"
  ) {
    return null;
  }
  return {
    voter: value.voter,
    choice,
    weight: weight.toString(),
    txHash: event.txHash,
    ledger,
    closedAt: event.ledgerClosedAt,
  };
}

/** Simulates a governance view that takes a `u32` proposal id and returns the decoded value. */
async function callGovernanceView(method: string, proposalId: number): Promise<unknown> {
  const { Contract, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
  const server = await getSorobanClient();
  const contract = new Contract(getGovernanceContractId());
  const result = await server.simulateTransaction(
    await buildReadOnlyTx(
      contract.call(method, nativeToScVal(proposalId, { type: "u32" })),
    ),
  );
  if ("error" in result) throw new Error("governance simulation failed");
  const retval = (result as { result?: { retval?: import("@stellar/stellar-sdk").xdr.ScVal } })
    .result?.retval;
  if (!retval) throw new Error("governance simulation returned no value");
  return scValToNative(retval);
}

async function readGovernance<T>(
  method: string,
  proposalId: number,
  parse: (native: unknown) => T | null,
): Promise<GovernanceRead<T>> {
  if (!getGovernanceContractId()) return { status: "not-configured" };
  try {
    const native = await callGovernanceView(method, proposalId);
    // `Option::None` decodes to null: the proposal does not exist.
    if (native === null || native === undefined) return { status: "not-found" };
    const data = parse(native);
    return data ? { status: "ok", data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** `get_proposal`: the stored proposal, or `not-found` if the id does not exist. */
export function getProposalOnChain(proposalId: number): Promise<GovernanceRead<OnChainProposal>> {
  return readGovernance("get_proposal", proposalId, parseOnChainProposal);
}

/**
 * `get_proposal_quorum_state`: quorum and consensus progress, exactly as the
 * contract computes it. The page shows these numbers; it does not recompute them.
 */
export function getProposalQuorumStateOnChain(
  proposalId: number,
): Promise<GovernanceRead<OnChainQuorumState>> {
  return readGovernance("get_proposal_quorum_state", proposalId, parseOnChainQuorumState);
}

/** The ledger range message Soroban RPC returns for an out-of-range `startLedger`. */
const LEDGER_RANGE = /ledger range:\s*(\d+)\s*-\s*(\d+)/i;

/**
 * One page of the proposal's `vote` events, oldest first.
 *
 * The contract has no call that lists voters (`get_vote` needs the voter's
 * address), so the list is read from the events it emits. Soroban RPC only
 * serves recent events (about a week), so older votes are not available here;
 * the tallies in the quorum state are the contract's and always complete.
 */
export async function getProposalVotesOnChain(
  proposalId: number,
  options: { cursor?: string; limit?: number } = {},
): Promise<GovernanceRead<OnChainVotePage>> {
  if (!getGovernanceContractId()) return { status: "not-configured" };

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? VOTES_PAGE_SIZE) || VOTES_PAGE_SIZE, 1),
    MAX_VOTES_PAGE_SIZE,
  );

  try {
    const { xdr, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
    const server = await getSorobanClient();

    const filters = [
      {
        type: "contract" as const,
        contractIds: [getGovernanceContractId()],
        topics: [
          [
            xdr.ScVal.scvSymbol("vote").toXDR("base64"),
            nativeToScVal(proposalId, { type: "u32" }).toXDR("base64"),
          ],
        ],
      },
    ];

    let response;
    if (options.cursor) {
      response = await server.getEvents({ filters, cursor: options.cursor, limit });
    } else {
      const latest = (await server.getLatestLedger()).sequence;
      let startLedger = Math.max(1, latest - EVENT_LOOKBACK_LEDGERS);
      try {
        response = await server.getEvents({ filters, startLedger, limit });
      } catch (error) {
        // The window we guessed starts before the oldest ledger the RPC keeps.
        const range = LEDGER_RANGE.exec(error instanceof Error ? error.message : "");
        if (!range) throw error;
        startLedger = Number(range[1]);
        response = await server.getEvents({ filters, startLedger, limit });
      }
    }

    const votes: OnChainVote[] = [];
    for (const event of response.events) {
      const vote = parseOnChainVoteEvent({
        txHash: (event as { txHash?: unknown }).txHash,
        ledger: event.ledger,
        ledgerClosedAt: event.ledgerClosedAt,
        value: scValToNative(event.value),
      });
      if (vote) votes.push(vote);
    }

    return {
      status: "ok",
      data: {
        votes,
        // A full page may be followed by more; a short page is the last.
        nextCursor: response.events.length >= limit ? response.cursor : null,
        oldestLedger: response.oldestLedger,
        latestLedger: response.latestLedger,
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Explorer link for a transaction hash. Returns `null` for anything that is not
 * a 64-character hex hash, so a stored value can never become an arbitrary URL.
 */
export function explorerTxUrl(txHash: string | null | undefined): string | null {
  if (!txHash || !/^[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const base =
    STELLAR_NETWORK === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash.toLowerCase()}`;
}


/**
 * Build a minimal read-only Soroban transaction for simulation.
 * Uses a dummy source account — no signing required for reads.
 */
async function buildReadOnlyTx(operation: unknown) {
  const { TransactionBuilder, BASE_FEE, Account } = await import("@stellar/stellar-sdk");
  const network = getNetwork();

  // Dummy account for read-only simulation
  const dummyAccount = new Account(
    await getDummyAccountPublicKey(),
    "0",
  );

  return new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(operation as Parameters<typeof TransactionBuilder.prototype.addOperation>[0])
    .setTimeout(30)
    .build();
}

/**
 * Validate that a Stellar public key is properly formatted (G... prefix, 56 chars).
 */
export function isValidStellarPublicKey(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Validate Stellar network for the connected wallet.
 * Throws a user-friendly error if on the wrong network.
 */
export async function ensureStellarNetwork(
  walletPublicKey: string,
): Promise<void> {
  if (!isValidStellarPublicKey(walletPublicKey)) {
    throw new Error(
      "Invalid Stellar public key. Please connect a Stellar wallet (Freighter, Albedo, etc.).",
    );
  }

  const { Horizon } = await import("@stellar/stellar-sdk");
  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);

  try {
    await server.loadAccount(walletPublicKey);
  } catch {
    if (STELLAR_NETWORK === "testnet") {
      throw new Error(
        `Account not found on Stellar Testnet. Fund your account at https://friendbot.stellar.org?addr=${walletPublicKey}`,
      );
    }
    throw new Error("Account not found on Stellar. Please fund your account first.");
  }
}
