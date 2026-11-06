/**
 * Optional integration with Dxcufgb's Debug Recorder (dxcufgbs-debug-recorder).
 *
 * The recorder is NOT a dependency: when it isn't installed or active, everything here does nothing and Tile
 * Triggers works exactly as without it. When it is active, Tile Triggers registers a snapshot of its runtime state
 * (see debugSnapshot in main.js) and leaves breadcrumbs at its main decision points while the GM records.
 *
 * Registration works whatever the load order: on the recorder's "dxcufgbs-debug-recorder.ready" hook, or at once
 * when its API already exists (checked at init and again at ready). It registers only once.
 *
 * Privacy: snapshot and breadcrumb data never contain names, free text, image paths or URLs; only counts, booleans,
 * numbers and this module's own fixed ids (event types, action types, reason codes). Document ids only as `docId`.
 * A recorder error never reaches the module: every call into it is wrapped in try/catch.
 */

import { MODULE_ID } from "./constants.js";

export const RECORDER_ID = "dxcufgbs-debug-recorder";

/** The recorder's API once this module is registered with it, else null. */
let recorder = null;
let snapshotFn = null;
let hooked = false;

/** Problems the module ran into since the page loaded: code -> count (shown in the snapshot). */
const errorCounts = {};
let lastErrorCode = null;

/** Register with the recorder's API, once; a failing register() only logs a warning. */
function attach(api) {
  if (recorder || !api || typeof api.register !== "function" || !snapshotFn) return;
  try {
    api.register(MODULE_ID, { snapshot: safeSnapshot });
    recorder = api;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not register with ${RECORDER_ID}`, err);
  }
}

/** The snapshot handed to the recorder: the module's snapshot, or { snapshotError: true } if it throws. */
function safeSnapshot() {
  try {
    return snapshotFn();
  } catch (err) {
    console.warn(`${MODULE_ID} | debug snapshot failed`, err);
    return { snapshotError: true };
  }
}

/** The recorder's API, when that module is active and has set it. */
function recorderApi() {
  try {
    return game.modules?.get(RECORDER_ID)?.api ?? null;
  } catch {
    return null;
  }
}

/**
 * Register with the recorder (call at init). Safe to call more than once; it registers a single time.
 * @param {() => object} snapshot  returns plain JSON data describing the module's runtime state
 */
export function registerDebugRecorder(snapshot) {
  snapshotFn = snapshot;
  if (!hooked) {
    hooked = true;
    Hooks.once(`${RECORDER_ID}.ready`, attach);
    // The recorder may have been ready before this module's init: try again once the world is ready
    Hooks.once("ready", () => attach(recorderApi()));
  }
  attach(recorderApi());
}

/**
 * Leave a breadcrumb while the recorder is recording; otherwise nothing happens.
 * @param {string} key    dot-namespaced, e.g. "trigger.fire"
 * @param {object|(() => object)} [data]  small flat object: counts, booleans, numbers, own ids. Never names or
 *                        free text. A function is only called while recording (for data that costs to build).
 */
export function crumb(key, data) {
  if (!recorder) return;
  try {
    if (recorder.isRecording?.() !== true) return;
    recorder.breadcrumb(MODULE_ID, key, typeof data === "function" ? data() : data);
  } catch {
    // A recorder bug must never break the module
  }
}

/** Count a problem the module ran into (a fixed code, never a message). Kept for the snapshot. */
export function noteError(code) {
  errorCounts[code] = (errorCounts[code] ?? 0) + 1;
  lastErrorCode = code;
}

/** The problem counts for the snapshot. */
export function errorState() {
  return { counts: { ...errorCounts }, last: lastErrorCode };
}

/**
 * A value as one of the module's own fixed ids: `value` when it is one of `allowed` (an array, or the keys of an
 * object), else "other". Keeps anything typed by hand in a flag out of a breadcrumb.
 */
export function ownId(value, allowed) {
  const ok = Array.isArray(allowed) ? allowed.includes(value) : (allowed && typeof value === "string" && Object.hasOwn(allowed, value));
  return ok ? value : "other";
}
