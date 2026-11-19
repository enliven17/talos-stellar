export function calculateMarketCap(
  pulsePrice: string | number | null | undefined,
  totalSupply: number | null | undefined,
): number | null {
  if (
    pulsePrice === null ||
    pulsePrice === undefined ||
    (typeof pulsePrice === "string" && pulsePrice.trim() === "") ||
    totalSupply === null ||
    totalSupply === undefined
  ) {
    return null;
  }

  const price = typeof pulsePrice === "number" ? pulsePrice : Number(pulsePrice);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(totalSupply) || totalSupply < 0) {
    return null;
  }

  const marketCap = price * totalSupply;
  const scaledMarketCap = marketCap * 1_000_000;
  if (!Number.isFinite(scaledMarketCap)) {
    return null;
  }

  // Pulse prices have six decimal places; keep market caps at the same precision.
  return Math.round(scaledMarketCap) / 1_000_000;
}
