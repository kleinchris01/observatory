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
