/**
 * Structured logger for Observatory backend.
 *
 * All log entries are emitted as single-line JSON to stdout/stderr so that
 * Forge's log aggregation can parse and filter them.  Callers pass a short
 * event name and an optional context object; the level and ISO timestamp are
 * added automatically.
 *
 * Usage:
 *   import { logger } from "./logger.js";
 *   logger.info("scan.start", { installationKey, totalProjects: 45 });
 *   logger.error("scan.failed", { installationKey, error: err.message });
 */

const LOG_LEVEL_NUM = { debug: 10, info: 20, warn: 30, error: 40 };
const ENV_LEVEL = (typeof process !== "undefined" && process.env?.LOG_LEVEL) || "info";
const MIN_LEVEL = LOG_LEVEL_NUM[ENV_LEVEL] ?? LOG_LEVEL_NUM.info;

function emit(level, event, data = {}) {
  if ((LOG_LEVEL_NUM[level] ?? 0) < MIN_LEVEL) return;
  const entry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event, data) => emit("debug", event, data),
  info:  (event, data) => emit("info",  event, data),
  warn:  (event, data) => emit("warn",  event, data),
  error: (event, data) => emit("error", event, data),
};

/**
 * A catch handler that records the failure and then degrades to a fallback.
 *
 * This exists because `.catch(() => null)` is the most expensive idiom in this
 * codebase. Degrading gracefully is right; degrading INVISIBLY is what turns a bug
 * into a mystery — three separate defects here reached production behind it:
 *
 *   - a failed issue count rendered as a confident "Site-wide issue count: 0" on a
 *     site holding 317,907 issues,
 *   - a 401 "scope does not match" on the workflow endpoint left every status looking
 *     unreachable for weeks with nothing in the logs,
 *   - a misparsed API response fabricated 142 phantom workflow schemes.
 *
 * In each case the fallback value was indistinguishable from real data. Naming the
 * event forces the author to say what was lost, and puts a searchable string in the
 * logs the moment it happens.
 *
 * Usage:
 *   await readMeta(key).catch(fallbackOn("scan.meta_read_failed", null, { key }))
 *   await writeThing(x).catch(fallbackOn("scan.log_append_failed", undefined))
 *
 * `fallback` may be a value or a factory — pass a factory for mutable defaults so
 * callers never share one array or Map instance.
 */
export function fallbackOn(event, fallback, context = {}) {
  return (error) => {
    logger.warn(event, {
      ...context,
      error: String(error?.message || error),
    });
    return typeof fallback === "function" ? fallback() : fallback;
  };
}

/**
 * For failures that are genuinely correct to ignore — a cleanup write issued while
 * already handling a different error, where there is nothing further to do and the
 * original error is the one that matters.
 *
 * Still logs, at debug rather than warn: the point is that the trace exists when
 * someone goes looking, not that it competes with the real failure. Silence is a
 * decision, so it gets a name too.
 */
export function ignoreWith(event, context = {}) {
  return (error) => {
    logger.debug(event, {
      ...context,
      error: String(error?.message || error),
    });
  };
}
