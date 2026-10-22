console.log("[compat:browser-bundle] loading bundle:", BUNDLE_PATH);
assert.ok(existsSync(BUNDLE_PATH), `browser bundle missing at ${BUNDLE_PATH}`);
const bytes = statSync(BUNDLE_PATH).size;
console.log(`[compat:browser-bundle] bundle size: ${bytes} bytes`);

const source = readFileSync(BUNDLE_PATH, "utf8");

// Emulate a minimal browser global: only the things the bundle should use.
const windowLike = {};
windowLike.crypto = crypto;
windowLike.globalThis = windowLike;
const windowLike = {
  crypto,
  TextEncoder,
  TextDecoder,
};
const globalThisLike = windowLike;
const context = {
  // Mimic a browser's globals. We deliberately do NOT expose Buffer, require,
  // __dirname, etc. — this catches accidental Node-only usage in the SDK's
  // production code. `self` and `window` are real browser globals the bundle
  // is allowed to use; `process` is shimmed inside the bundle itself (see
  // scripts/bundle-browser.mjs) and must NOT be provided here.
  window: windowLike,
  self: windowLike,
  globalThis: globalThisLike,
  TextEncoder,
  TextDecoder,
  btoa,
  crypto,
  fetch: () => {
    throw new Error("fetch should not be called during import-time smoke test");
  },
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  AbortController,
  AbortSignal,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
  DataView,
  ArrayBuffer,
  Promise,
  Date,
  Map,
  Set,
  WeakMap,
  WeakSet,
  console,
  Error,
  SyntaxError,
  TypeError,
  RangeError,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  parseInt,
  parseFloat,
  isNaN,
  URLSearchParams,
  URL,
  Headers,
  Request,
  Response,
  ReadableStream,
  TextEncoder,
  TextDecoder,
};
