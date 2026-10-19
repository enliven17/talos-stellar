/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias */
// Polyfills for ES2024 features required by jsdom on Node 20
class IteratorPolyfill {
  [Symbol.iterator]() {
    return this;
  }
  find(predicate: (item: unknown) => boolean) {
    for (const item of this as any) {
      if (predicate(item)) return item;
    }
    return undefined;
  }
  filter(predicate: (item: unknown) => boolean) {
    const self = this;
    return (function* () {
      for (const item of self as any) {
        if (predicate(item)) yield item;
      }
    })();
  }
  map(mapper: (item: unknown) => unknown) {
    const self = this;
    return (function* () {
      for (const item of self as any) {
        yield mapper(item);
      }
    })();
  }
  some(predicate: (item: unknown) => boolean) {
    for (const item of this as any) {
      if (predicate(item)) return true;
    }
    return false;
  }
  every(predicate: (item: unknown) => boolean) {
    for (const item of this as any) {
      if (!predicate(item)) return false;
    }
    return true;
  }
  toArray() {
    return [...(this as any)];
  }
}

if (typeof (globalThis as any).Iterator === "undefined") {
  (globalThis as any).Iterator = IteratorPolyfill;
}

if (!Promise.withResolvers) {
  Promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
