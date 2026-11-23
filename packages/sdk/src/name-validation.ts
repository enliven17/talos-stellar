/**
 * Name validation utilities for Talos name service.
 *
 * These functions mirror the validation logic in the Soroban smart contract
 * to ensure client-side validation matches on-chain validation.
 *
 * Validation rules (from contract):
 * - Length: 3-32 characters
 * - Characters: lowercase alphanumeric (a-z, 0-9) and hyphens (-)
 * - No leading hyphens
 * - No trailing hyphens
 * - No consecutive hyphens
 *
 * Canonicalization rules:
 * - Trim leading/trailing ASCII whitespace (space, tab, newline, carriage-return)
 * - Lowercase ASCII letters (A-Z → a-z)
 */

/**
 * Validate a Talos name according to contract rules.
 *
 * @param name - The name to validate
 * @returns true if the name is valid, false otherwise
 */
export function validateName(name: string): boolean {
  const len = name.length;
  if (len < 3 || len > 32) {
    return false;
  }

  if (name[0] === "-" || name[len - 1] === "-") {
    return false;
  }

  let prevHyphen = false;
  for (let i = 0; i < len; i++) {
    const char = name[i];
    const code = char.charCodeAt(0);

    if (
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) // 0-9
    ) {
      prevHyphen = false;
    } else if (code === 45) {
      // hyphen
      if (prevHyphen) {
        return false;
      }
      prevHyphen = true;
    } else {
      return false;
    }
  }

  return true;
}

/**
 * Canonicalize a caller-supplied name before validation.
 *
 * Rules (applied left-to-right, in order):
 * 1. Trim leading and trailing ASCII whitespace (space, tab, newline, carriage-return)
 * 2. Lowercase any ASCII uppercase letters (A-Z → a-z)
 *
 * @param name - The name to canonicalize
 * @returns The canonicalized name
 * @throws Error if the name is empty after canonicalization
 */
export function canonicalizeName(name: string): string {
  // Step 1: trim ASCII whitespace
  let start = 0;
  let end = name.length;

  while (start < end && isAsciiWhitespace(name.charCodeAt(start))) {
    start++;
  }

  while (end > start && isAsciiWhitespace(name.charCodeAt(end - 1))) {
    end--;
  }

  if (start === end) {
    throw new Error("Name cannot be empty after canonicalization");
  }

  // Step 2: lowercase in-place
  const trimmed = name.slice(start, end);
  const result = trimmed.toLowerCase();

  if (result.length > 32) {
    throw new Error("Name exceeds maximum byte length after canonicalization");
  }

  return result;
}

/**
 * Check if a character code is ASCII whitespace.
 */
function isAsciiWhitespace(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // newline
    code === 0x0d // carriage-return
  );
}

/**
 * Validate and canonicalize a name in one step.
 *
 * @param name - The name to validate and canonicalize
 * @returns The canonicalized name if valid
 * @throws Error if the name is invalid or canonicalization fails
 */
export function validateAndCanonicalizeName(name: string): string {
  const canonicalized = canonicalizeName(name);
  if (!validateName(canonicalized)) {
    throw new Error(
      "Invalid name. Must be 3-32 chars, lowercase alphanumeric + hyphens, no consecutive hyphens."
    );
  }
  return canonicalized;
}
