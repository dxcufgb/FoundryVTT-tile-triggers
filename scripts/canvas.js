/**
 * Canvas side: click triggers and the GM-only outlines on tiles that have triggers.
 */

import { MODULE_ID } from "./constants.js";
import { tileContains, tileShape } from "./geometry.js";
import { getTriggers, tileActive, shouldFire, dispatch, isEnabled } from "./engine.js";
import { tileName } from "./actions.js";

/* -------------------------------------------- */
/*  Click triggers                              */
/* -------------------------------------------- */

let down = null;

// DOM listeners on the <canvas> element: they see every click, whatever PIXI object is under the pointer
function onPointerDown(event) {
  if (event.button !== 0 || !canvas.ready) { down = null; return; }
  down = {
    x: event.clientX, y: event.clientY, t: Date.now(),
    // Remember the selection now: clicking empty canvas releases tokens before pointerup
    controlled: canvas.tokens?.controlled.map(t => t.document) ?? []
  };
}

function onPointerUp(event) {
  const d = down;
  down = null;
  if (!d || event.button !== 0 || !canvas.ready) return;
  if (Math.hypot(event.clientX - d.x, event.clientY - d.y) > 6 || Date.now() - d.t > 600) return;
  if (!isEnabled() || canvas.activeLayer !== canvas.tokens) return;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  handleClick(point, d.controlled);
}

/** Is the token within `range` grid spaces of the tile (0 = standing on it)? */
function inRange(token, tile, range) {
  const g = token.parent.grid;
  const pad = Math.max(0, Number(range) || 0) * g.size - 1;
  const tx0 = token.x - pad, ty0 = token.y - pad;
  const tx1 = token.x + token.width * g.sizeX + pad, ty1 = token.y + token.height * g.sizeY + pad;
  return tx0 < tile.x + tile.width && tx1 > tile.x && ty0 < tile.y + tile.height && ty1 > tile.y;
}

function handleClick(point, controlled) {
  const scene = canvas.scene;
  const tiles = scene.tiles
    .filter(t => tileActive(t) && tileContains(t, point) && getTriggers(t).some(tr => tr.enabled && tr.event === "click"))
    .sort((a, b) => b.sort - a.sort);
  if (!tiles.length) return;

  const mine = controlled.filter(t => t.parent === scene && t.isOwner);
  const owned = game.user.isGM ? [] : scene.tokens.filter(t => t.isOwner && t.actor?.isOwner);
  let tooFar = false;
  for (const tile of tiles) {
    for (const trigger of getTriggers(tile)) {
      if (!trigger.enabled || trigger.event !== "click") continue;
      const pool = mine.length ? mine : owned;
      const token = pool.find(t => inRange(t, tile, trigger.clickRange)) ?? null;
      if (!token && pool.length) { tooFar = true; continue; }
      if (!token && !game.user.isGM) continue;
      if (!shouldFire(tile, trigger, token)) continue;
      dispatch({ sceneId: scene.id, tileId: tile.id, triggerId: trigger.id, event: "click", tokenId: token?.id ?? null, userId: game.user.id });
      return;
    }
  }
  if (tooFar) ui.notifications.info(game.i18n.localize("DXTT.Notify.TooFar"));
}

/* -------------------------------------------- */
/*  Outlines (GM only)                          */
/* -------------------------------------------- */

let layer = null;

export function drawIndicators() {
  if (!canvas.ready) return;
  if (layer && !layer.destroyed) layer.destroy({ children: true });
  layer = null;
  if (!game.user.isGM || !game.settings.get(MODULE_ID, "showIndicators")) return;

  layer = new PIXI.Container();
  layer.name = "dxtt-indicators";
  layer.eventMode = "none";
  canvas.interface.addChild(layer);

  const PreciseText = foundry.canvas.containers.PreciseText;
  for (const tile of canvas.scene.tiles) {
    const triggers = getTriggers(tile);
    if (!triggers.length) continue;
    const on = tileActive(tile) && triggers.some(t => t.enabled);
    const color = on ? 0xff8c28 : 0x888888;
    const g = new PIXI.Graphics();
    const pts = outline(tile);
    g.lineStyle({ width: 3, color, alpha: 0.9 });
    g.beginFill(color, 0.06);
    g.drawPolygon(pts);
    g.endFill();
    layer.addChild(g);

    const label = `⚡ ${tileName(tile) !== game.i18n.localize("DXTT.TileUnnamed") ? `${tileName(tile)} · ` : ""}${triggers.length}`;
    const style = PreciseText.getTextStyle({ fontSize: 22, fill: color, strokeThickness: 4, stroke: 0x111111 });
    const text = new PreciseText(label, style);
    text.position.set(Math.min(...pts.filter((_, i) => i % 2 === 0)) + 6, Math.min(...pts.filter((_, i) => i % 2 === 1)) + 4);
    text.alpha = 0.95;
    layer.addChild(text);
  }
}

/** The tile's trigger area as a flat [x, y, x, y, ...] polygon. */
function outline(tile) {
  const { x, y, width: w, height: h, rotation } = tile;
  const cx = x + w / 2, cy = y + h / 2;
  const r = Math.toRadians(rotation || 0);
  const c = Math.cos(r), s = Math.sin(r);
  const local = [];
  if (tileShape(tile) === "ellipse") {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      local.push([(Math.cos(a) * w) / 2, (Math.sin(a) * h) / 2]);
    }
  } else local.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
  return local.flatMap(([px, py]) => [cx + px * c - py * s, cy + px * s + py * c]);
}

export function registerCanvas() {
  Hooks.on("canvasReady", () => {
    const view = canvas.app?.view;
    if (view && !view._dxttClicks) {
      view.addEventListener("pointerdown", onPointerDown, true);
      view.addEventListener("pointerup", onPointerUp, true);
      view._dxttClicks = true;
    }
    drawIndicators();
  });
  for (const hook of ["createTile", "updateTile", "deleteTile"]) {
    Hooks.on(hook, doc => { if (doc.parent === canvas.scene) drawIndicators(); });
  }
}
