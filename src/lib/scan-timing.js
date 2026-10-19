// Timing constants shared by the scan orchestrator and the admin UI. Kept in a module with
// no imports so the browser bundle can use it: full-scan.js pulls in the Forge queue.

// The orchestrator writes updatedAt on every step, so a run silent for this long has stopped:
// a lost queue message, or a consumer killed mid-stage.
export const FULL_SCAN_STALL_MS = 20 * 60 * 1000;
