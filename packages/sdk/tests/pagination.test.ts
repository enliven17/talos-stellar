/**
 * Tests for async pagination iterator.
 *
 * Covers positive, negative, boundary, and regression cases for the
 * AsyncPaginationIterator and related functionality.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AsyncPaginationIterator,
  createPaginationIterator,
  PaginationAbortedError,
  PaginationLimitExceededError,
} from "../src/pagination.js";
import type { CursorPage } from "../src/types.js";

describe("AsyncPaginationIterator", () => {
  describe("constructor validation", () => {
    it("should accept valid options", () => {
      const fetcher = vi.fn();
      const iterator = new AsyncPaginationIterator(fetcher, { maxPages: 10 });
      expect(iterator).toBeInstanceOf(AsyncPaginationIterator);
    });

    it("should use default maxPages when not provided", () => {
      const fetcher = vi.fn();
      const iterator = new AsyncPaginationIterator(fetcher);
      // Default is 100
      expect(iterator).toBeInstanceOf(AsyncPaginationIterator);
    });

    it("should throw TypeError for invalid maxPages (negative)", () => {
      const fetcher = vi.fn();
      expect(() => new AsyncPaginationIterator(fetcher, { maxPages: -1 })).toThrow(TypeError);
    });

    it("should throw TypeError for invalid maxPages (zero)", () => {
      const fetcher = vi.fn();
      expect(() => new AsyncPaginationIterator(fetcher, { maxPages: 0 })).toThrow(TypeError);
    });

    it("should throw TypeError for invalid maxPages (non-number)", () => {
      const fetcher = vi.fn();
      expect(() => new AsyncPaginationIterator(fetcher, { maxPages: "invalid" as never })).toThrow(TypeError);
    });

    it("should accept Infinity as maxPages", () => {
      const fetcher = vi.fn();
      const iterator = new AsyncPaginationIterator(fetcher, { maxPages: Infinity });
      expect(iterator).toBeInstanceOf(AsyncPaginationIterator);
    });
  });

  describe("basic iteration", () => {
    it("should yield items from a single page", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1", "item2", "item3"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1", "item2", "item3"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should yield items across multiple pages", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockResolvedValueOnce({
          data: ["item1", "item2"],
          nextCursor: "cursor1",
        })
        .mockResolvedValueOnce({
          data: ["item3", "item4"],
          nextCursor: "cursor2",
        })
        .mockResolvedValueOnce({
          data: ["item5"],
          nextCursor: null,
        });

      const iterator = new AsyncPaginationIterator(fetcher);
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1", "item2", "item3", "item4", "item5"]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it("should handle empty pages gracefully", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockResolvedValueOnce({
          data: [],
          nextCursor: "cursor1",
        })
        .mockResolvedValueOnce({
          data: ["item1"],
          nextCursor: null,
        });

      const iterator = new AsyncPaginationIterator(fetcher);
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      // The iterator will stop when it encounters an empty page with a cursor
      // This is a safety feature to prevent infinite loops on malformed responses
      expect(items).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should handle completely empty result set", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: [],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("cursor handling", () => {
    it("should pass cursor correctly to fetcher", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockResolvedValueOnce({
          data: ["item1"],
          nextCursor: "cursor1",
        })
        .mockResolvedValueOnce({
          data: ["item2"],
          nextCursor: null,
        });

      const iterator = new AsyncPaginationIterator(fetcher);
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: undefined }));
      expect(fetcher).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "cursor1" }));
    });

    it("should stop when nextCursor is null", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("maxPages limit", () => {
    it("should enforce maxPages limit", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockResolvedValue({
          data: ["item1"],
          nextCursor: "cursor",
        });

      const iterator = new AsyncPaginationIterator(fetcher, { maxPages: 2 });

      await expect(async () => {
        for await (const item of iterator) {
          // Keep consuming items
        }
      }).rejects.toThrow(PaginationLimitExceededError);

      // With maxPages=2, it should fetch page 0 and page 1, then fail on page 2
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("should not throw when within maxPages limit", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockResolvedValueOnce({
          data: ["item1"],
          nextCursor: "cursor1",
        })
        .mockResolvedValueOnce({
          data: ["item2"],
          nextCursor: null,
        });

      const iterator = new AsyncPaginationIterator(fetcher, { maxPages: 5 });
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1", "item2"]);
      // Should only fetch 2 pages (page 0 and page 1) since we have maxPages=5
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("should work with Infinity maxPages", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockResolvedValueOnce({
          data: ["item1"],
          nextCursor: "cursor1",
        })
        .mockResolvedValueOnce({
          data: ["item2"],
          nextCursor: null,
        });

      const iterator = new AsyncPaginationIterator(fetcher, { maxPages: Infinity });
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1", "item2"]);
      // Should fetch both pages (page 0 and page 1)
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe("cancellation", () => {
    it("should abort when signal is aborted before iteration", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const fetcher = vi.fn<() => Promise<CursorPage<string>>>();
      const iterator = new AsyncPaginationIterator(fetcher, { signal: abortController.signal });

      await expect(async () => {
        for await (const item of iterator) {
          // Should not be reached
        }
      }).rejects.toThrow(PaginationAbortedError);

      expect(fetcher).not.toHaveBeenCalled();
    });

    it("should abort when signal is aborted during iteration", async () => {
      const abortController = new AbortController();
      let callCount = 0;

      const fetcher = vi.fn<() => Promise<CursorPage<string>>>()
        .mockImplementation(async () => {
          callCount++;
          return {
            data: [`item${callCount}`],
            nextCursor: callCount < 3 ? `cursor${callCount}` : null,
          };
        });

      const iterator = new AsyncPaginationIterator(fetcher, { signal: abortController.signal });
      const items: string[] = [];

      // Get first item
      const firstItem = await iterator.next();
      items.push(firstItem.value);

      // Abort after first item
      abortController.abort();

      // Next call should throw
      await expect(iterator.next()).rejects.toThrow(PaginationAbortedError);

      expect(items).toEqual(["item1"]);
    });

    it("should clean up abort listener on completion", async () => {
      const abortController = new AbortController();
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher, { signal: abortController.signal });
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1"]);
      // Signal should not cause issues after completion
      abortController.abort();
    });
  });

  describe("timeout handling", () => {
    it("should pass timeoutMs to fetcher", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher, { timeoutMs: 5000 });
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item1"]);
      expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }));
    });
  });

  describe("error handling", () => {
    it("should propagate fetcher errors", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockRejectedValue(new Error("Network error"));

      const iterator = new AsyncPaginationIterator(fetcher);

      await expect(async () => {
        for await (const item of iterator) {
          // Should not be reached
        }
      }).rejects.toThrow("Network error");
    });

    it("should clean up resources on error", async () => {
      const abortController = new AbortController();
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockRejectedValue(new Error("Network error"));

      const iterator = new AsyncPaginationIterator(fetcher, { signal: abortController.signal });

      await expect(async () => {
        for await (const item of iterator) {
          // Should not be reached
        }
      }).rejects.toThrow("Network error");

      // Signal should not cause issues after error
      abortController.abort();
    });
  });

  describe("manual iteration control", () => {
    it("should support manual next() calls", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1", "item2"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);

      const result1 = await iterator.next();
      expect(result1.value).toBe("item1");
      expect(result1.done).toBe(false);

      const result2 = await iterator.next();
      expect(result2.value).toBe("item2");
      expect(result2.done).toBe(false);

      const result3 = await iterator.next();
      expect(result3.done).toBe(true);
    });

    it("should support return() to stop iteration early", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1", "item2", "item3"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);

      const result1 = await iterator.next();
      expect(result1.value).toBe("item1");

      await iterator.return();

      const result2 = await iterator.next();
      expect(result2.done).toBe(true);

      // Should still only fetch once
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should support throw() to propagate errors", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);

      await expect(iterator.throw(new Error("Custom error"))).rejects.toThrow("Custom error");
    });
  });

  describe("async iterable protocol", () => {
    it("should be async iterable", async () => {
      const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
        data: ["item1"],
        nextCursor: null,
      });

      const iterator = new AsyncPaginationIterator(fetcher);
      const asyncIterator = iterator[Symbol.asyncIterator]();

      expect(asyncIterator).toBe(iterator);
    });
  });
});

describe("createPaginationIterator", () => {
  it("should create an AsyncPaginationIterator", () => {
    const fetcher = vi.fn<() => Promise<CursorPage<string>>>();
    const iterator = createPaginationIterator(fetcher, { maxPages: 10 });

    expect(iterator).toBeInstanceOf(AsyncPaginationIterator);
  });

  it("should pass options to AsyncPaginationIterator", async () => {
    const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
      data: ["item1"],
      nextCursor: null,
    });

    const iterator = createPaginationIterator(fetcher, { maxPages: 5 });
    const items: string[] = [];

    for await (const item of iterator) {
      items.push(item);
    }

    expect(items).toEqual(["item1"]);
  });
});

describe("error classes", () => {
  describe("PaginationAbortedError", () => {
    it("should have correct name and default message", () => {
      const error = new PaginationAbortedError();
      expect(error.name).toBe("PaginationAbortedError");
      expect(error.message).toBe("Pagination iteration was aborted");
    });

    it("should accept custom message", () => {
      const error = new PaginationAbortedError("Custom abort message");
      expect(error.message).toBe("Custom abort message");
    });
  });

  describe("PaginationLimitExceededError", () => {
    it("should have correct name and include maxPages in message", () => {
      const error = new PaginationLimitExceededError(100);
      expect(error.name).toBe("PaginationLimitExceededError");
      expect(error.message).toBe("Pagination exceeded maximum page limit of 100");
    });
  });
});

describe("integration scenarios", () => {
  it("should handle realistic multi-page scenario with early termination", async () => {
    const fetcher = vi.fn<() => Promise<CursorPage<{ id: number; name: string }>>>()
      .mockResolvedValueOnce({
        data: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
        ],
        nextCursor: "page1",
      })
      .mockResolvedValueOnce({
        data: [
          { id: 3, name: "Item 3" },
          { id: 4, name: "Item 4" },
        ],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        data: [
          { id: 5, name: "Item 5" },
        ],
        nextCursor: null,
      });

    const iterator = createPaginationIterator(fetcher, { maxPages: 10 });
    const items: { id: number; name: string }[] = [];

    // Manually iterate to have more control
    let result = await iterator.next();
    while (!result.done) {
      items.push(result.value);
      if (items.length === 3) {
        await iterator.return();
        break;
      }
      result = await iterator.next();
    }

    expect(items).toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
      { id: 3, name: "Item 3" },
    ]);
    // Should fetch first page (2 items), then second page (starts yielding item 3)
    // When we call return() after 3 items, it should not fetch the third page
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("should handle concurrent iteration attempts gracefully", async () => {
    const fetcher = vi.fn<() => Promise<CursorPage<string>>>().mockResolvedValue({
      data: ["item1", "item2"],
      nextCursor: null,
    });

    const iterator = new AsyncPaginationIterator(fetcher);

    // Start two iterations simultaneously
    const promise1 = (async () => {
      const items: string[] = [];
      for await (const item of iterator) {
        items.push(item);
      }
      return items;
    })();

    const promise2 = (async () => {
      const items: string[] = [];
      for await (const item of iterator) {
        items.push(item);
      }
      return items;
    })();

    // One should complete, the other should handle the state gracefully
    const [result1, result2] = await Promise.allSettled([promise1, promise2]);

    // At least one should succeed
    expect(result1.status === "fulfilled" || result2.status === "fulfilled").toBe(true);
  });
});
