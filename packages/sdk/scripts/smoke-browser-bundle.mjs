console.log("[compat:browser-bundle] loading bundle:", BUNDLE_PATH);
assert.ok(existsSync(BUNDLE_PATH), `browser bundle missing at ${BUNDLE_PATH}`);
const bytes = statSync(BUNDLE_PATH).size;
console.log(`[compat:browser-bundle] bundle size: ${bytes} bytes`);

const source = readFileSync(BUNDLE_PATH, "utf8");

// Emulate a minimal browser global: only the things the bundle should use.
const windowLike = {};
windowLike.crypto = crypto;
windowLike.globalThis = windowLike;
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
};
