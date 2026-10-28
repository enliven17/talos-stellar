/**
 * Async pagination iterator for safe, predictable traversal of paginated endpoints.
 *
 * Provides an async iterator interface that fetches pages on-demand, respecting
 * cancellation signals and implementing safety bounds to prevent runaway loops.
 *
 * @example
 * ```ts
 * for await (const talos of client.paginateTaloses({ limit: 50 })) {
 *   console.log(talos.name);
 * }
 * ```
 */

import type { CursorPage, CursorRequestOptions } from "./types.js";

/**
 * Options for async pagination iteration.
 */
export interface AsyncPaginationIteratorOptions {
  /**
   * Maximum number of pages to fetch (safety cap to prevent runaway loops).
   * Default: 100. Set to `Infinity` for unbounded traversal (not recommended for production).
   */
  maxPages?: number;
  /**
   * AbortSignal for cancellation. When aborted, the iterator stops
   * and throws an error similar to a cancelled fetch request.
   */
  signal?: AbortSignal | undefined;
  /**
   * Per-request timeout in milliseconds. Overrides the client-level
   * `timeoutMs` for each page fetch.
   */
  timeoutMs?: number | undefined;
}

/**
 * Error thrown when pagination iteration is aborted.
 */
export class PaginationAbortedError extends Error {
  constructor(message = "Pagination iteration was aborted") {
    super(message);
    this.name = "PaginationAbortedError";
  }
}

/**
 * Error thrown when pagination exceeds the maximum page limit.
 */
export class PaginationLimitExceededError extends Error {
  constructor(maxPages: number) {
    super(`Pagination exceeded maximum page limit of ${maxPages}`);
    this.name = "PaginationLimitExceededError";
  }
}

/**
 * Internal state for the pagination iterator.
 */
interface PaginationState<T> {
  cursor: string | null;
  currentPage: number;
  currentItems: T[];
  itemIndex: number;
  exhausted: boolean;
  fetchedFirstPage: boolean;
}

/**
 * Type-safe fetcher function for a single page.
 */
type PageFetcher<T> = (options: CursorRequestOptions) => Promise<CursorPage<T>>;

/**
 * Async iterator for cursor-based pagination.
 *
 * Fetches pages on-demand and yields individual items. Implements safety bounds
 * via `maxPages` and respects cancellation via `AbortSignal`.
 *
 * @template T - The type of items in the paginated results.
 */
export class AsyncPaginationIterator<T> implements AsyncIterableIterator<T> {
  private readonly fetcher: PageFetcher<T>;
  private readonly options: AsyncPaginationIteratorOptions;
  private state: PaginationState<T>;
  private abortController: AbortController | null = null;

  /**
   * Create a new pagination iterator.
   *
   * @param fetcher - Function that fetches a single page of results.
   * @param options - Iteration options.
   */
  constructor(
    fetcher: PageFetcher<T>,
    options: AsyncPaginationIteratorOptions = {},
  ) {
    this.fetcher = fetcher;
    
    const maxPages = options.maxPages ?? 100;
    
    // Validate maxPages is a positive number or Infinity
    if (typeof maxPages !== "number" || maxPages <= 0) {
      throw new TypeError("maxPages must be a positive number or Infinity");
    }

    this.options = {
      maxPages,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    };

    this.state = {
      cursor: null,
      currentPage: 0,
      currentItems: [],
      itemIndex: 0,
      exhausted: false,
      fetchedFirstPage: false,
    };

    // Set up abort handling if a signal is provided
    if (this.options.signal) {
      this.abortController = new AbortController();
      if (this.options.signal.aborted) {
        this.state.exhausted = true;
      } else {
        this.options.signal.addEventListener("abort", this.handleAbort, { once: true });
      }
    }
  }

  /**
   * Handle abort signal from the caller.
   */
  private handleAbort = (): void => {
    this.state.exhausted = true;
    this.abortController?.abort();
  };

  /**
   * Fetch the next page of results.
   */
  private async fetchNextPage(): Promise<void> {
    // Check if we've hit the page limit
    if (this.state.currentPage >= (this.options.maxPages ?? 100)) {
      throw new PaginationLimitExceededError(this.options.maxPages ?? 100);
    }

    // Check if we've been aborted
    if (this.options.signal?.aborted || this.abortController?.signal.aborted) {
      throw new PaginationAbortedError();
    }

    // Merge caller's signal with our internal abort controller
    const signal = this.abortController?.signal ?? this.options.signal;

    try {
      const fetchOptions: CursorRequestOptions = {
        cursor: this.state.cursor ?? undefined,
      };
      
      if (signal) {
        fetchOptions.signal = signal;
      }
      
      if (this.options.timeoutMs !== undefined) {
        fetchOptions.timeoutMs = this.options.timeoutMs;
      }

      const page = await this.fetcher(fetchOptions);

      this.state.currentItems = page.data;
      this.state.cursor = page.nextCursor;
      this.state.itemIndex = 0;
      this.state.currentPage++;
      this.state.fetchedFirstPage = true;

      // Don't mark as exhausted yet - we'll do that after yielding all items
      // from this page if there's no next cursor
    } catch (error) {
      // Clean up abort listener on error
      this.cleanup();
      throw error;
    }
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.options.signal) {
      this.options.signal.removeEventListener("abort", this.handleAbort);
    }
    this.abortController = null;
  }

  /**
   * Get the next item from the pagination iterator.
   *
   * @returns Promise that resolves to the next item or `undefined` when exhausted.
   * @throws {PaginationAbortedError} When the iteration is cancelled.
   * @throws {PaginationLimitExceededError} When maxPages is exceeded.
   * @throws {TalosAPIError} When a page fetch fails.
   */
  async next(): Promise<IteratorResult<T>> {
    // Check if we've been aborted
    if (this.options.signal?.aborted || this.abortController?.signal.aborted) {
      this.cleanup();
      throw new PaginationAbortedError();
    }

    // If we haven't fetched the first page yet, fetch it
    if (!this.state.fetchedFirstPage) {
      await this.fetchNextPage();
      // If the first page is empty, we're done
      if (this.state.currentItems.length === 0) {
        this.cleanup();
        return { done: true, value: undefined as unknown as T };
      }
    }

    // If we've exhausted all items in the current page, try to fetch the next page
    if (this.state.itemIndex >= this.state.currentItems.length) {
      // If there's no next cursor, we're done
      if (!this.state.cursor) {
        this.cleanup();
        return { done: true, value: undefined as unknown as T };
      }

      await this.fetchNextPage();

      // If the new page is empty, we're done
      if (this.state.currentItems.length === 0) {
        this.cleanup();
        return { done: true, value: undefined as unknown as T };
      }
    }

    // Return the current item and advance the index
    const value = this.state.currentItems[this.state.itemIndex];
    this.state.itemIndex++;

    return { done: false, value };
  }

  /**
   * Make the iterator iterable (for `for await...of` loops).
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  /**
   * Explicitly stop iteration and clean up resources.
   *
   * Call this to manually stop iteration before it completes naturally.
   * This is useful when you want to stop iteration early without waiting
   * for the next `next()` call.
   */
  async return(): Promise<IteratorResult<T>> {
    this.state.exhausted = true;
    this.state.currentItems = []; // Clear remaining items
    this.cleanup();
    return { done: true, value: undefined as unknown as T };
  }

  /**
   * Handle errors during iteration.
   */
  async throw(error?: unknown): Promise<IteratorResult<T>> {
    this.cleanup();
    throw error;
  }
}

/**
 * Create an async pagination iterator from a page fetcher.
 *
 * This is a convenience function that creates an `AsyncPaginationIterator`
 * with the given fetcher and options.
 *
 * @template T - The type of items in the paginated results.
 * @param fetcher - Function that fetches a single page of results.
 * @param options - Iteration options.
 * @returns An async iterable iterator.
 *
 * @example
 * ```ts
 * const iterator = createPaginationIterator(
 *   (opts) => client.listTaloses(opts),
 *   { maxPages: 50 }
 * );
 *
 * for await (const talos of iterator) {
 *   console.log(talos.name);
 * }
 * ```
 */
export function createPaginationIterator<T>(
  fetcher: PageFetcher<T>,
  options?: AsyncPaginationIteratorOptions,
): AsyncPaginationIterator<T> {
  return new AsyncPaginationIterator(fetcher, options);
}
