/**
 * Screen shake: shakes the canvas view (not the UI) for a moment, then puts the view back exactly as it was.
 *
 * The "Screen shake" action runs on the active GM, which sends a "shake" socket message to the chosen users
 * (see engine.js, which checks that a GM sent it). Each client shakes only while it views the tile's scene,
 * and only when its "Allow screen shake" setting is on (players who get motion sick switch it off).
 *
 * The shake moves canvas.stage.position by a small offset each frame. The offset of the previous frame is
 * taken off before the next one is added, and the last one at the end, so whatever Foundry does to the view
 * meanwhile (a pan, a zoom, a window resize) is kept and nothing of the shake stays behind.
 */

import { MODULE_ID } from "./constants.js";

/** Shake strengths in screen pixels. */
export const SHAKE_STRENGTHS = { low: 6, medium: 14, high: 28 };
export const SHAKE_MAX = 100;
export const SHAKE_MAX_SECONDS = 10;

/** The amplitude (pixels) of a "Screen shake" action: a named strength, or a number for "custom". */
export function shakeAmplitude(action) {
  if (action?.strength === "custom") {
    const n = Number(action.amount);
    return Number.isFinite(n) ? Math.clamp(n, 0, SHAKE_MAX) : SHAKE_STRENGTHS.medium;
  }
  return SHAKE_STRENGTHS[action?.strength] ?? SHAKE_STRENGTHS.medium;
}

/** The duration (seconds) of a "Screen shake" action, between 0.1 and 10. */
export function shakeSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.clamp(n, 0.1, SHAKE_MAX_SECONDS) : 1;
}

let current = null;

/** Stop a running shake and take its offset off the view. */
export function stopShake() {
  const s = current;
  current = null;
  if (!s) return;
  s.ticker?.remove(s.tick);
  const stage = s.stage;
  if (stage && !stage.destroyed) stage.position.set(stage.position.x - s.dx, stage.position.y - s.dy);
}

/**
 * Shake this client's canvas view.
 * @param {number} amplitude  pixels
 * @param {number} seconds
 * @returns {boolean}  false when nothing shook (setting off, no canvas, no strength)
 */
export function shakeCanvas(amplitude, seconds) {
  if (!game.settings.get(MODULE_ID, "allowShake")) return false;
  const stage = canvas?.ready ? canvas.stage : null;
  const ticker = canvas?.app?.ticker;
  amplitude = Math.clamp(Number(amplitude) || 0, 0, SHAKE_MAX);
  if (!stage || !ticker || !amplitude) return false;
  stopShake();
  const ms = shakeSeconds(seconds) * 1000;
  const start = performance.now();
  const s = { stage, ticker, dx: 0, dy: 0, tick: null };
  // Two out-of-step waves per axis feel like a rumble rather than a regular wobble
  const p = Array.from({ length: 4 }, () => Math.random() * Math.PI * 2);
  s.tick = () => {
    if (current !== s) return;
    if (stage.destroyed) { current = null; ticker.remove(s.tick); return; }
    const t = performance.now() - start;
    if (t >= ms) return stopShake();
    const fade = 1 - t / ms;
    const a = amplitude * fade * fade;
    const w = t / 1000;
    const dx = a * (0.7 * Math.sin(w * 47 + p[0]) + 0.3 * Math.sin(w * 83 + p[1]));
    const dy = a * (0.7 * Math.sin(w * 53 + p[2]) + 0.3 * Math.sin(w * 71 + p[3]));
    stage.position.set(stage.position.x - s.dx + dx, stage.position.y - s.dy + dy);
    s.dx = dx;
    s.dy = dy;
  };
  current = s;
  ticker.add(s.tick);
  return true;
}

/**
 * A "shake" socket message (a GM sent it; engine.js checks that). Every field is checked here.
 * @param {{sceneId:string, users:string[], amplitude:number, seconds:number}} msg
 */
export function onShakeMessage(msg) {
  if (Array.isArray(msg.users) && msg.users.length && !msg.users.includes(game.user.id)) return;
  if (typeof msg.sceneId !== "string" || canvas.scene?.id !== msg.sceneId) return;
  const amplitude = Number(msg.amplitude), seconds = Number(msg.seconds);
  if (!Number.isFinite(amplitude) || !Number.isFinite(seconds)) return;
  shakeCanvas(amplitude, seconds);
}

export function registerShake() {
  Hooks.on("canvasTearDown", () => stopShake());
}
