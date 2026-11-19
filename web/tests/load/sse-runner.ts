import { Agent, fetch as undiciFetch } from "undici";

export interface SseSaturationResult {
  attempted: number;
  accepted: number;
  poolRejected: number;
  rateLimited: number;
  stillPending: number;
  otherFailures: number;
}

/**
 * Open `count` concurrent SSE connections to `url`. Uses a dedicated
 * undici Agent with a raised connection-pool size, since Node's default
 * fetch pool silently queues requests past a small per-origin limit.
 */
export async function saturateSse(
  url: string,
  count: number,
  settleMs: number,
  holdMs: number
): Promise<SseSaturationResult> {
  let accepted = 0;
  let poolRejected = 0;
  let rateLimited = 0;
  let stillPending = 0;
  let otherFailures = 0;

  const agent = new Agent({ connections: count + 10 });
  const controllers: AbortController[] = [];

  const attempts = Array.from({ length: count }, async () => {
    const controller = new AbortController();
    controllers.push(controller);

    let settled = false;
    const settleTimer = setTimeout(() => {
      if (!settled) stillPending++;
    }, settleMs);

    try {
      const res = await undiciFetch(url, { signal: controller.signal, dispatcher: agent });
      settled = true;
      clearTimeout(settleTimer);

      if (res.status === 200) accepted++;
      else if (res.status === 503) poolRejected++;
      else if (res.status === 429) rateLimited++;
      else otherFailures++;
    } catch {
      settled = true;
      clearTimeout(settleTimer);
      if (!controller.signal.aborted) otherFailures++;
    }
  });

  await new Promise((resolve) => setTimeout(resolve, settleMs + holdMs));

  for (const c of controllers) c.abort();
  await Promise.allSettled(attempts);
  await agent.close();

  return { attempted: count, accepted, poolRejected, rateLimited, stillPending, otherFailures };
}