import { Keypair } from "@stellar/stellar-sdk";

export const REQUEST_SIGNATURE_VERSION = "talos-request-v1" as const;

export type SigningCapability =
  | "http-request-v1"
  | "stellar-transaction-v1"
  | "talos-payment-v1";

export interface SignerCapabilities {
  capabilities: readonly SigningCapability[];
  algorithms: readonly string[];
  maxConcurrent?: number;
}

export interface SigningPayload {
  kind: SigningCapability;
  bytes: Uint8Array;
}

export interface SignOptions {
  signal?: AbortSignal;
  requestId?: string;
}

export interface SignatureResult {
  algorithm: string;
  keyId: string;
  signature: Uint8Array;
  metadata?: Readonly<Record<string, string>>;
}

export interface RequestSigner {
  getCapabilities(): SignerCapabilities | Promise<SignerCapabilities>;
  sign(payload: SigningPayload, options?: SignOptions): Promise<SignatureResult>;
}

export type SigningErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED"
  | "UNAVAILABLE"
  | "SATURATED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESULT"
  | "SIGNING_FAILED";

export class SigningError extends Error {
  constructor(
    public readonly code: SigningErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SigningError";
  }
}

export interface SigningEvent {
  name:
    | "signing.started"
    | "signing.succeeded"
    | "signing.failed"
    | "signing.saturated";
  requestId?: string;
  capability: SigningCapability;
  durationMs?: number;
  errorCode?: SigningErrorCode;
  active: number;
  queued: number;
}

export interface SigningControllerOptions {
  timeoutMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  onEvent?: (event: SigningEvent) => void;
}

export interface CanonicalRequest {
  method: string;
  url: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  timestamp: string;
  nonce: string;
}

const encoder = new TextEncoder();
const SIGNATURE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-talos-algorithm",
  "x-talos-key-id",
  "x-talos-nonce",
  "x-talos-signature",
  "x-talos-signature-version",
  "x-talos-timestamp",
]);

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return new Uint8Array(digest);
}

async function bodyBytes(body?: BodyInit | null): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new SigningError(
    "INVALID_INPUT",
    "Streaming, FormData, and unknown request bodies cannot be signed deterministically",
    false,
  );
}

function canonicalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new SigningError("INVALID_INPUT", "A request URL must be absolute", false, { cause });
  }
  url.hash = "";
  const entries = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk),
  );
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
  return url.toString();
}

/**
 * Canonical request format (v1): LF-delimited version, method, normalized URL,
 * safe sorted headers, SHA-256 body digest, timestamp, and nonce.
 */
export async function canonicalizeRequest(request: CanonicalRequest): Promise<Uint8Array> {
  const method = request.method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method) || !request.timestamp || !request.nonce) {
    throw new SigningError("INVALID_INPUT", "Invalid method, timestamp, or nonce", false);
  }
  const headers = [...new Headers(request.headers).entries()]
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .filter(([key]) => !SIGNATURE_HEADERS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
  const digest = base64Url(await sha256(await bodyBytes(request.body)));
  return encoder.encode(
    [
      REQUEST_SIGNATURE_VERSION,
      method,
      canonicalUrl(request.url),
      headers,
      digest,
      request.timestamp,
      request.nonce,
    ].join("\n"),
  );
}

export async function detectSignerCapability(
  signer: RequestSigner,
  capability: SigningCapability,
): Promise<boolean> {
  try {
    const result = await signer.getCapabilities();
    return result.capabilities.includes(capability);
  } catch {
    return false;
  }
}

type QueueItem = {
  run: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
};

export class SigningController {
  private active = 0;
  private readonly queue: QueueItem[] = [];
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;

  constructor(
    private readonly signer: RequestSigner,
    private readonly options: SigningControllerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxQueue = options.maxQueue ?? 32;
    if (this.timeoutMs < 1 || this.maxConcurrent < 1 || this.maxQueue < 0) {
      throw new SigningError("INVALID_INPUT", "Signing limits must be positive", false);
    }
  }

  async sign(payload: SigningPayload, options: SignOptions = {}): Promise<SignatureResult> {
    if (options.signal?.aborted) throw cancelled(options.signal.reason);
    const capabilities = await Promise.resolve(this.signer.getCapabilities()).catch(
      (cause: unknown) => {
        throw new SigningError("UNAVAILABLE", "Signer capability detection failed", true, {
          cause,
        });
      },
    );
    if (!capabilities.capabilities.includes(payload.kind)) {
      throw new SigningError("UNSUPPORTED", `Signer does not support ${payload.kind}`, false);
    }
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) {
        this.emit("signing.saturated", payload.kind, options.requestId, undefined, "SATURATED");
        throw new SigningError("SATURATED", "Signing queue is full", true);
      }
      return new Promise<SignatureResult>((resolve, reject) => {
        const item: QueueItem = {
          signal: options.signal,
          reject,
          run: () => void this.execute(payload, options).then(resolve, reject),
        };
        this.queue.push(item);
        options.signal?.addEventListener(
          "abort",
          () => {
            const index = this.queue.indexOf(item);
            if (index >= 0) this.queue.splice(index, 1);
            reject(cancelled(options.signal?.reason));
          },
          { once: true },
        );
      });
    }
    return this.execute(payload, options);
  }

  private async execute(payload: SigningPayload, options: SignOptions): Promise<SignatureResult> {
    this.active += 1;
    const started = Date.now();
    this.emit("signing.started", payload.kind, options.requestId);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const onAbort = () => timeout.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([
        this.signer.sign(payload, { ...options, signal: timeout.signal }),
        new Promise<never>((_, reject) => {
          timeout.signal.addEventListener(
            "abort",
            () =>
              reject(
                options.signal?.aborted
                  ? cancelled(options.signal.reason)
                  : new SigningError("TIMEOUT", "Signer timed out", true),
              ),
            { once: true },
          );
        }),
      ]);
      if (!result.keyId || !result.algorithm || result.signature.length === 0) {
        throw new SigningError("INVALID_RESULT", "Signer returned an incomplete signature", false);
      }
      this.emit("signing.succeeded", payload.kind, options.requestId, Date.now() - started);
      return result;
    } catch (cause) {
      const error =
        cause instanceof SigningError
          ? cause
          : new SigningError("SIGNING_FAILED", "Signer failed", true, { cause });
      this.emit("signing.failed", payload.kind, options.requestId, Date.now() - started, error.code);
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (!item.signal?.aborted) item.run();
    }
  }

  private emit(
    name: SigningEvent["name"],
    capability: SigningCapability,
    requestId?: string,
    durationMs?: number,
    errorCode?: SigningErrorCode,
  ): void {
    try {
      this.options.onEvent?.({
        name,
        capability,
        requestId,
        durationMs,
        errorCode,
        active: this.active,
        queued: this.queue.length,
      });
    } catch {
      // Telemetry must never alter signing correctness or release behavior.
    }
  }
}

function cancelled(cause?: unknown): SigningError {
  return new SigningError("CANCELLED", "Signing was cancelled", false, { cause });
}

export interface StellarKeypairSignerOptions {
  keyId?: string;
  capabilities?: readonly SigningCapability[];
}

/** Local signer intended for controlled server-side use; never logs or exports its seed. */
export class StellarKeypairSigner implements RequestSigner {
  private readonly keypair: Keypair;
  private readonly keyId: string;
  private readonly supported: readonly SigningCapability[];

  constructor(secret: string, options: StellarKeypairSignerOptions = {}) {
    try {
      this.keypair = Keypair.fromSecret(secret);
    } catch (cause) {
      throw new SigningError("INVALID_INPUT", "Invalid Stellar secret seed", false, { cause });
    }
    this.keyId = options.keyId ?? this.keypair.publicKey();
    this.supported = options.capabilities ?? ["http-request-v1", "stellar-transaction-v1"];
  }

  getCapabilities(): SignerCapabilities {
    return { capabilities: this.supported, algorithms: ["ed25519"], maxConcurrent: 64 };
  }

  async sign(payload: SigningPayload, options?: SignOptions): Promise<SignatureResult> {
    if (options?.signal?.aborted) throw cancelled(options.signal.reason);
    if (!this.supported.includes(payload.kind)) {
      throw new SigningError("UNSUPPORTED", `Signer does not support ${payload.kind}`, false);
    }
    return {
      algorithm: "ed25519",
      keyId: this.keyId,
      signature: this.keypair.sign(Buffer.from(payload.bytes)),
    };
  }
}

export function encodeSignature(bytes: Uint8Array): string {
  return base64Url(bytes);
}
