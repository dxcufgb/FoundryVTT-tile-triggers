/**
 * Arming and disarming a tile.
 *
 * A disarmed tile (flags["dxcufgbs-tile-triggers"].disarmed === true) fires none of its triggers
 * automatically, exactly like a tile whose "Triggers on this tile are active" box is unticked. It is
 * kept as its own flag so the GM can tell "this trap was dealt with" apart from "switched off".
 * GM-forced manual fires (the ▶ button, api.fire) still run on a disarmed tile.
 *
 * Whenever the flag changes, however it changed (Tile HUD, Tile Triggers window, the armTile action,
 * the API, or a direct flag edit), every client calls the hook
 *   Hooks.callAll("dxcufgbs-tile-triggers.disarm", tile, disarmed)
 */

import { MODULE_ID } from "./constants.js";

const resolve = tile => (typeof tile === "string" ? fromUuidSync(tile) : tile?.document ?? tile);

/** Is the tile disarmed? Accepts a TileDocument, a Tile or a UUID. */
export function isDisarmed(tile) {
  return resolve(tile)?.flags?.[MODULE_ID]?.disarmed === true;
}

/**
 * Disarm (true) or re-arm (false) a tile.
 * @param {TileDocument|Tile|string} tile   the tile, or its UUID
 * @param {boolean} value                   true = disarmed
 * @param {object} [options]
 * @param {boolean} [options.resetFired=false]  when arming, also forget what its triggers have fired
 *                                              for, so "once" triggers can fire again
 * @returns {Promise<TileDocument|null>}
 */
export async function setDisarmed(tile, value, { resetFired = false } = {}) {
  tile = resolve(tile);
  if (!tile) return null;
  value = !!value;
  const update = {};
  if (isDisarmed(tile) !== value) update[`flags.${MODULE_ID}.disarmed`] = value;
  if (!value && resetFired && tile.flags?.[MODULE_ID]?.state) update[`flags.${MODULE_ID}.-=state`] = null;
  if (foundry.utils.isEmpty(update)) return tile;
  await tile.update(update);
  return tile;
}

/** Did this tile update change the disarmed flag? (Foundry strips unchanged values from `changes`.) */
function disarmChanged(changes) {
  const f = changes?.flags?.[MODULE_ID];
  return !!f && (("disarmed" in f) || ("-=disarmed" in f));
}

export function registerDisarm() {
  Hooks.on("updateTile", (tile, changes) => {
    if (!disarmChanged(changes)) return;
    Hooks.callAll(`${MODULE_ID}.disarm`, tile, isDisarmed(tile));
    // Keep an open Tile HUD in step (its shield button shows the state)
    const hud = canvas.hud?.tile;
    if (hud?.rendered && hud.object?.document === tile) hud.render();
  });
}
