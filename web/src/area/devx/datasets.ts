export interface DatasetOptions {
  size: number;
  seed?: number;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

export function generateTalosIds(size: number, seed = 42): string[] {
  const rng = seededRandom(seed);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const ids: string[] = [];
  for (let i = 0; i < size; i++) {
    let id = "";
    for (let j = 0; j < 24; j++) {
      id += chars[Math.floor(rng() * chars.length)];
    }
    ids.push(id);
  }
  return ids;
}

export function generatePayloads(size: number, seed = 42): Record<string, unknown>[] {
  const rng = seededRandom(seed);
  const payloads: Record<string, unknown>[] = [];
  for (let i = 0; i < size; i++) {
    payloads.push({
      index: i,
      value: Math.floor(rng() * 10000),
      label: `item-${i}`,
      tags: Array.from({ length: Math.floor(rng() * 5) + 1 }, () => `tag-${Math.floor(rng() * 20)}`),
    });
  }
  return payloads;
}

export function generateActivityEntries(size: number, seed = 42): {
  type: string;
  content: string;
  channel: string;
}[] {
  const rng = seededRandom(seed);
  const types = ["post", "research", "reply", "engagement", "commerce", "approval"];
  const channels = ["twitter", "discord", "telegram", "email", "web"];
  const entries: {
    type: string;
    content: string;
    channel: string;
  }[] = [];
  for (let i = 0; i < size; i++) {
    entries.push({
      type: types[Math.floor(rng() * types.length)],
      content: `Benchmark activity entry #${i} with some variable-length content for realistic simulation`,
      channel: channels[Math.floor(rng() * channels.length)],
    });
  }
  return entries;
}

export function generateTransferPayloads(size: number, seed = 42): {
  agent: string;
  destination: string;
  asset: string;
  amount: string;
  nonce: string;
  expiry: string;
  signature: string;
}[] {
  const rng = seededRandom(seed);
  const payloads: {
    agent: string;
    destination: string;
    asset: string;
    amount: string;
    nonce: string;
    expiry: string;
    signature: string;
  }[] = [];
  for (let i = 0; i < size; i++) {
    const whole = Math.floor(rng() * 1000);
    const fraction = String(Math.floor(rng() * 100)).padStart(2, "0");
    const nonce = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rng() * 16)]).join("");
    const expiry = String(Math.floor(Date.now() / 1000) + 3600);
    payloads.push({
      agent: `agent-${i}`,
      destination: `G${Array.from({ length: 55 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(rng() * 32)]).join("")}`,
      asset: "USDC",
      amount: `${whole}.${fraction}`,
      nonce,
      expiry,
      signature: nonce,
    });
  }
  return payloads;
}