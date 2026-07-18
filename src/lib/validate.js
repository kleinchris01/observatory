/**
 * Input validation utilities for resolver functions.
 *
 * All functions throw a descriptive Error on validation failure.
 * Forge resolver infrastructure surfaces the error message to the client.
 * No external dependencies — safe for Forge sandbox environments.
 */

/**
 * Asserts that value is a string (any string, including empty).
 * Returns the string. Use requireNonEmptyString when a blank value is invalid.
 */
export function requireString(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string (got ${value === null ? "null" : typeof value})`);
  }
  return value;
}

/**
 * Asserts that value is a non-empty string after trimming.
 * Returns the trimmed string.
 */
export function requireNonEmptyString(value, name, maxLength = 10_000) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.trim().length > maxLength) {
    throw new Error(`${name} must not exceed ${maxLength.toLocaleString()} characters`);
  }
  return value.trim();
}

/**
 * Asserts that value is an integer in the range [1, max].
 * Returns the integer.
 */
export function requirePositiveInt(value, name, max = 1_000_000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be an integer between 1 and ${max.toLocaleString()} (got ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Asserts that value is an integer in the range [min, max] (both inclusive).
 * Returns the integer.
 */
export function requireBoundedInt(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Asserts that value is an Array.
 * Returns the array.
 */
export function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array (got ${value === null ? "null" : typeof value})`);
  }
  return value;
}

/**
 * Asserts that value is a boolean.
 * Returns the boolean.
 */
export function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean (got ${value === null ? "null" : typeof value})`);
  }
  return value;
}

/**
 * Returns the string value if present and non-null, or null if the value is
 * null / undefined / not supplied. Throws if the value is present but not a string.
 */
export function optionalString(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string or null (got ${typeof value})`);
  }
  return value;
}

/**
 * Returns the integer value if present, or defaultValue if the value is null / undefined.
 * Throws if the value is present but not a positive integer within [1, max].
 */
export function optionalPositiveInt(value, name, defaultValue, max = 1_000_000) {
  if (value === null || value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a positive integer up to ${max.toLocaleString()} (got ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Returns the value if it is one of the allowed strings, or null/defaultValue if
 * the value is null / undefined. Throws if the value is present but not allowed.
 */
export function optionalEnum(value, name, allowed, defaultValue = null) {
  if (value === null || value === undefined) return defaultValue;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of [${allowed.map((a) => JSON.stringify(a)).join(", ")}] (got ${JSON.stringify(value)})`);
  }
  return value;
}
