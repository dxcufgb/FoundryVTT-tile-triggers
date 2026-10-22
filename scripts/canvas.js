/**
 * Canvas side: click triggers and the GM-only outlines on tiles that have triggers.
 */

import { MODULE_ID } from "./constants.js";
import { tileContains, tileShape, tokenInRange } from "./geometry.js";
import { getTriggers, tileActive, shouldFire, dispatch, isEnabled } from "./engine.js";
import { tileName } from "./actions.js";
import { isDisarmed } from "./disarm.js";

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
      const token = pool.find(t => tokenInRange(t, tile, trigger.clickRange)) ?? null;
      if (!token && pool.length) { tooFar = true; continue; }
      if (!token && !game.user.isGM) continue;
      if (!shouldFire(tile, trigger, token)) continue;
      dispatch({ sceneId: scene.id, tileId: tile.id, triggerId: trigger.id, event: "click", tokenId: token?.id ?? null });
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
    // Orange = armed and active, muted green dashed = disarmed, grey = switched off
    const disarmed = isDisarmed(tile);
    const on = tileActive(tile) && triggers.some(t => t.enabled);
    const color = disarmed ? 0x5fa05f : (on ? 0xff8c28 : 0x888888);
    const g = new PIXI.Graphics();
    const pts = outline(tile);
    g.beginFill(color, disarmed ? 0.04 : 0.06);
    g.drawPolygon(pts);
    g.endFill();
    g.lineStyle({ width: 3, color, alpha: 0.9 });
    if (disarmed) dashedPolygon(g, pts, 16, 10);
    else g.drawPolygon(pts);
    layer.addChild(g);

    const name = tileName(tile) !== game.i18n.localize("DXTT.TileUnnamed") ? `${tileName(tile)} · ` : "";
    const suffix = disarmed ? ` · ${game.i18n.localize("DXTT.Outline.Disarmed")}` : "";
    const label = `⚡ ${name}${triggers.length}${suffix}`;
    const style = PreciseText.getTextStyle({ fontSize: 22, fill: color, strokeThickness: 4, stroke: 0x111111 });
    const text = new PreciseText(label, style);
    text.position.set(Math.min(...pts.filter((_, i) => i % 2 === 0)) + 6, Math.min(...pts.filter((_, i) => i % 2 === 1)) + 4);
    text.alpha = 0.95;
    layer.addChild(text);
  }
}

/** Stroke a closed polygon ([x, y, x, y, ...]) as dashes. */
function dashedPolygon(g, pts, dash, gap) {
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1];
    const x1 = pts[((i + 1) % n) * 2], y1 = pts[((i + 1) % n) * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!len) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(d + dash, len);
      g.moveTo(x0 + ux * d, y0 + uy * d);
      g.lineTo(x0 + ux * e, y0 + uy * e);
    }
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
