/**
 * A2A Intent and Decision Operations
 * 
 * Handles concurrency, retry, timeout, restart, duplication, and cancellation
 * scenarios for A2A purchase intents and deterministic decisions.
 */

import type {
  A2APurchaseIntent,
  DeterministicDecision,
} from "./a2a-intent";

// ── Operation States ───────────────────────────────────────────────────

export type OperationState = 
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "retrying";

export type OperationType = "intent_submission" | "decision_evaluation" | "intent_fulfillment";

// ── Operation Configuration ────────────────────────────────────────────

export interface OperationConfig {
  maxRetries: number;
  retryDelay: number; // milliseconds
  timeout: number; // milliseconds
  idempotencyWindow: number; // milliseconds
  concurrencyLimit: number;
}

export const DEFAULT_OPERATION_CONFIG: OperationConfig = {
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 30000, // 30 seconds
  idempotencyWindow: 60000, // 1 minute
  concurrencyLimit: 10,
};

// ── Operation Context ─────────────────────────────────────────────────

export interface OperationContext {
  operationId: string;
  operationType: OperationType;
  state: OperationState;
  attempt: number;
  startedAt: string;
  lastAttemptAt: string;
  completedAt?: string;
  error?: string;
  config: OperationConfig;
}

// ── Idempotency Key Management ────────────────────────────────────────

class IdempotencyManager {
  private store = new Map<string, { timestamp: number; result: unknown }>();
  private window: number;

  constructor(window: number = DEFAULT_OPERATION_CONFIG.idempotencyWindow) {
    this.window = window;
  }

  /**
   * Check if an operation with the given idempotency key exists and is within the window
   */
  has(idempotencyKey: string): boolean {
    const entry = this.store.get(idempotencyKey);
    if (!entry) return false;

    const now = Date.now();
    if (now - entry.timestamp > this.window) {
      this.store.delete(idempotencyKey);
      return false;
    }

    return true;
  }

  /**
   * Get the result of a previous operation with the same idempotency key
   */
  get(idempotencyKey: string): unknown | undefined {
    const entry = this.store.get(idempotencyKey);
    if (!entry) return undefined;

    const now = Date.now();
    if (now - entry.timestamp > this.window) {
      this.store.delete(idempotencyKey);
      return undefined;
    }

    return entry.result;
  }

  /**
   * Store the result of an operation with its idempotency key
   */
  set(idempotencyKey: string, result: unknown): void {
    this.store.set(idempotencyKey, {
      timestamp: Date.now(),
      result,
    });
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.timestamp > this.window) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.store.clear();
  }
}

// ── Concurrency Control ─────────────────────────────────────────────

class ConcurrencyController {
  private activeOperations = new Map<string, OperationContext>();
  private limit: number;

  constructor(limit: number = DEFAULT_OPERATION_CONFIG.concurrencyLimit) {
    this.limit = limit;
  }

  /**
   * Check if a new operation can be started
   */
  canStart(): boolean {
    return this.activeOperations.size < this.limit;
  }

  /**
   * Register a new operation
   */
  register(context: OperationContext): boolean {
    if (!this.canStart()) return false;
    this.activeOperations.set(context.operationId, context);
    return true;
  }

  /**
   * Unregister an operation
   */
  unregister(operationId: string): void {
    this.activeOperations.delete(operationId);
  }

  /**
   * Get the number of active operations
   */
  getActiveCount(): number {
    return this.activeOperations.size;
  }

  /**
   * Get all active operations
   */
  getActiveOperations(): OperationContext[] {
    return Array.from(this.activeOperations.values());
  }
}

// ── Retry Logic ──────────────────────────────────────────────────────

class RetryManager {
  private config: OperationConfig;

  constructor(config: OperationConfig = DEFAULT_OPERATION_CONFIG) {
    this.config = config;
  }

  /**
   * Determine if an operation should be retried
   */
  shouldRetry(attempt: number, error: Error): boolean {
    if (attempt >= this.config.maxRetries) return false;

    // Don't retry on certain error types
    const nonRetryableErrors = [
      "MALFORMED_REQUEST",
      "MISSING_REQUIRED_FIELDS",
      "INVALID_SIGNATURE",
      "DUPLICATE_REQUEST",
    ];

    if (nonRetryableErrors.some(code => error.message.includes(code))) {
      return false;
    }

    return true;
  }

  /**
   * Calculate the delay before the next retry (exponential backoff)
   */
  getRetryDelay(attempt: number): number {
    return this.config.retryDelay * Math.pow(2, attempt);
  }

  /**
   * Execute an operation with retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: OperationContext
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      context.attempt = attempt;
      context.lastAttemptAt = new Date().toISOString();

      try {
        return await this.executeWithTimeout(operation, context);
      } catch (error) {
        lastError = error as Error;
        
        if (!this.shouldRetry(attempt, lastError)) {
          throw lastError;
        }

        context.state = "retrying";
        const delay = this.getRetryDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Execute an operation with timeout
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    context: OperationContext
  ): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error("OPERATION_TIMEOUT")), this.config.timeout)
      ),
    ]);
  }
}

// ── Cancellation Handler ─────────────────────────────────────────────

class CancellationHandler {
  private cancelledOperations = new Set<string>();

  /**
   * Cancel an operation
   */
  cancel(operationId: string): boolean {
    if (this.cancelledOperations.has(operationId)) {
      return false; // Already cancelled
    }
    this.cancelledOperations.add(operationId);
    return true;
  }

  /**
   * Check if an operation is cancelled
   */
  isCancelled(operationId: string): boolean {
    return this.cancelledOperations.has(operationId);
  }

  /**
   * Remove an operation from the cancelled set
   */
  clear(operationId: string): void {
    this.cancelledOperations.delete(operationId);
  }

  /**
   * Clear all cancelled operations
   */
  clearAll(): void {
    this.cancelledOperations.clear();
  }
}

// ── Operation Manager ─────────────────────────────────────────────────

export class A2AOperationManager {
  private idempotencyManager: IdempotencyManager;
  private concurrencyController: ConcurrencyController;
  private retryManager: RetryManager;
  private cancellationHandler: CancellationHandler;
  private config: OperationConfig;

  constructor(config: Partial<OperationConfig> = {}) {
    this.config = { ...DEFAULT_OPERATION_CONFIG, ...config };
    this.idempotencyManager = new IdempotencyManager(this.config.idempotencyWindow);
    this.concurrencyController = new ConcurrencyController(this.config.concurrencyLimit);
    this.retryManager = new RetryManager(this.config);
    this.cancellationHandler = new CancellationHandler();
  }

  /**
   * Submit an A2A purchase intent with idempotency and retry logic
   */
  async submitIntent(
    intent: A2APurchaseIntent,
    operation: (intent: A2APurchaseIntent) => Promise<unknown>
  ): Promise<unknown> {
    const operationId = intent.intentId;
    const idempotencyKey = intent.idempotencyKey || operationId;

    // Check for duplicate request
    if (this.idempotencyManager.has(idempotencyKey)) {
      const previousResult = this.idempotencyManager.get(idempotencyKey);
      if (previousResult !== undefined) {
        return previousResult;
      }
    }

    // Check concurrency limit
    if (!this.concurrencyController.canStart()) {
      throw new Error("CONCURRENCY_LIMIT_REACHED");
    }

    // Create operation context
    const context: OperationContext = {
      operationId,
      operationType: "intent_submission",
      state: "pending",
      attempt: 0,
      startedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      config: this.config,
    };

    // Register operation
    if (!this.concurrencyController.register(context)) {
      throw new Error("FAILED_TO_REGISTER_OPERATION");
    }

    try {
      // Check for cancellation before starting
      if (this.cancellationHandler.isCancelled(operationId)) {
        context.state = "cancelled";
        throw new Error("OPERATION_CANCELLED");
      }

      context.state = "processing";
      
      // Execute with retry logic
      const result = await this.retryManager.executeWithRetry(
        () => operation(intent),
        context
      );

      context.state = "completed";
      context.completedAt = new Date().toISOString();

      // Store result for idempotency
      this.idempotencyManager.set(idempotencyKey, result);

      return result;
    } catch (error) {
      context.state = "failed";
      context.error = (error as Error).message;
      context.completedAt = new Date().toISOString();
      throw error;
    } finally {
      this.concurrencyController.unregister(operationId);
    }
  }

  /**
   * Evaluate a decision with idempotency and retry logic
   */
  async evaluateDecision(
    decision: DeterministicDecision,
    operation: (decision: DeterministicDecision) => Promise<unknown>
  ): Promise<unknown> {
    const operationId = decision.decisionId;
    const idempotencyKey = operationId;

    // Check for duplicate request
    if (this.idempotencyManager.has(idempotencyKey)) {
      const previousResult = this.idempotencyManager.get(idempotencyKey);
      if (previousResult !== undefined) {
        return previousResult;
      }
    }

    // Check concurrency limit
    if (!this.concurrencyController.canStart()) {
      throw new Error("CONCURRENCY_LIMIT_REACHED");
    }

    // Create operation context
    const context: OperationContext = {
      operationId,
      operationType: "decision_evaluation",
      state: "pending",
      attempt: 0,
      startedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      config: this.config,
    };

    // Register operation
    if (!this.concurrencyController.register(context)) {
      throw new Error("FAILED_TO_REGISTER_OPERATION");
    }

    try {
      // Check for cancellation before starting
      if (this.cancellationHandler.isCancelled(operationId)) {
        context.state = "cancelled";
        throw new Error("OPERATION_CANCELLED");
      }

      context.state = "processing";
      
      // Execute with retry logic
      const result = await this.retryManager.executeWithRetry(
        () => operation(decision),
        context
      );

      context.state = "completed";
      context.completedAt = new Date().toISOString();

      // Store result for idempotency
      this.idempotencyManager.set(idempotencyKey, result);

      return result;
    } catch (error) {
      context.state = "failed";
      context.error = (error as Error).message;
      context.completedAt = new Date().toISOString();
      throw error;
    } finally {
      this.concurrencyController.unregister(operationId);
    }
  }

  /**
   * Cancel an operation
   */
  cancelOperation(operationId: string): boolean {
    return this.cancellationHandler.cancel(operationId);
  }

  /**
   * Get the status of an operation
   */
  getOperationStatus(operationId: string): OperationContext | undefined {
    return this.concurrencyController.getActiveOperations().find(
      op => op.operationId === operationId
    );
  }

  /**
   * Get all active operations
   */
  getActiveOperations(): OperationContext[] {
    return this.concurrencyController.getActiveOperations();
  }

  /**
   * Clean up expired idempotency entries
   */
  cleanup(): void {
    this.idempotencyManager.cleanup();
  }

  /**
   * Reset the operation manager state
   */
  reset(): void {
    this.idempotencyManager.clear();
    this.cancellationHandler.clearAll();
  }

  /**
   * Update the operation configuration
   */
  updateConfig(config: Partial<OperationConfig>): void {
    this.config = { ...this.config, ...config };
    this.idempotencyManager = new IdempotencyManager(this.config.idempotencyWindow);
    this.concurrencyController = new ConcurrencyController(this.config.concurrencyLimit);
    this.retryManager = new RetryManager(this.config);
  }
}

// ── Utility Functions ────────────────────────────────────────────────

/**
 * Create a unique operation ID
 */
export function createOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: Error): boolean {
  const nonRetryablePatterns = [
    "MALFORMED_REQUEST",
    "MISSING_REQUIRED_FIELDS",
    "INVALID_SIGNATURE",
    "DUPLICATE_REQUEST",
    "OPERATION_CANCELLED",
  ];

  return !nonRetryablePatterns.some(pattern => error.message.includes(pattern));
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoff(attempt: number, baseDelay: number = 1000): number {
  return baseDelay * Math.pow(2, attempt);
}

/**
 * Check if an operation has timed out
 */
export function hasOperationTimedOut(context: OperationContext): boolean {
  const startedAt = new Date(context.startedAt).getTime();
  const now = Date.now();
  return (now - startedAt) > context.config.timeout;
}
