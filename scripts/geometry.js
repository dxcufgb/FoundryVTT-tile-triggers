/**
 * Geometry helpers: is a point / token inside a tile, and where along a movement path does a
 * token enter or leave a tile.
 */

import { MODULE_ID } from "./constants.js";

/** The shape of a tile's trigger area ("rectangle" or "ellipse"). */
export function tileShape(tile) {
  return tile.getFlag?.(MODULE_ID, "shape") ?? tile.flags?.[MODULE_ID]?.shape ?? "rectangle";
}

/**
 * Is a point inside the tile (rotation and shape aware)?
 * @param {TileDocument} tile
 * @param {{x:number,y:number}} p
 */
export function tileContains(tile, p) {
  const { x, y, width, height, rotation } = tile;
  const w = Math.abs(width), h = Math.abs(height);
  const cx = x + w / 2, cy = y + h / 2;
  let dx = p.x - cx, dy = p.y - cy;
  if (rotation) {
    const r = -Math.toRadians(rotation);
    const c = Math.cos(r), s = Math.sin(r);
    [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  }
  if (tileShape(tile) === "ellipse") {
    const a = w / 2, b = h / 2;
    if (!a || !b) return false;
    return (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;
  }
  return Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2;
}

/** Is the token within `range` grid spaces of the tile (0 = standing on it)? Used by click triggers. */
export function tokenInRange(token, tile, range) {
  const g = token.parent.grid;
  const pad = Math.max(0, Number(range) || 0) * g.size - 1;
  const tx0 = token.x - pad, ty0 = token.y - pad;
  const tx1 = token.x + token.width * g.sizeX + pad, ty1 = token.y + token.height * g.sizeY + pad;
  return tx0 < tile.x + tile.width && tx1 > tile.x && ty0 < tile.y + tile.height && ty1 > tile.y;
}

/** The centre of a token if it stood at the given position. */
export function centerAt(token, pos) {
  if (typeof token.getCenterPoint === "function") return token.getCenterPoint(pos);
  const g = token.parent.grid;
  return { x: pos.x + ((pos.width ?? token.width) * g.sizeX) / 2, y: pos.y + ((pos.height ?? token.height) * g.sizeY) / 2 };
}

/**
 * Does a token standing at `pos` count as being inside the tile?
 * "center": the token's centre is in the tile. "overlap": any part of the token (inset a little so
 * merely touching an edge doesn't count) is in the tile.
 */
export function tokenInside(tile, token, pos, detection = "center") {
  pos ??= token;
  if (detection !== "overlap") return tileContains(tile, centerAt(token, pos));
  const g = token.parent.grid;
  const w = (pos.width ?? token.width) * g.sizeX, h = (pos.height ?? token.height) * g.sizeY;
  const inset = 0.08;
  const N = 5;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const px = pos.x + w * (inset + ((1 - 2 * inset) * i) / (N - 1));
      const py = pos.y + h * (inset + ((1 - 2 * inset) * j) / (N - 1));
      if (tileContains(tile, { x: px, y: py })) return true;
    }
  }
  return false;
}

/**
 * Turn a movement into a list of positions to test, in order. On a gridded scene the path Foundry
 * gives us already has one waypoint per grid space, so those are used as they are (a token can only
 * stop on a grid space). On a gridless scene each straight segment is sampled in small steps.
 * @param {TokenDocument} token
 * @param {object} origin              where the token starts
 * @param {object[]} waypoints         the complete path (including intermediate waypoints)
 * @returns {{pos:object, index:number, sampled:boolean}[]}  index = waypoint index the sample belongs to
 */
export function samplePath(token, origin, waypoints) {
  const scene = token.parent;
  const gridless = scene.grid.isGridless;
  const out = [{ pos: origin, index: -1, sampled: false }];
  let prev = origin;
  const step = Math.max(4, scene.grid.size / 8);
  waypoints.forEach((wp, index) => {
    if (gridless && wp.action !== "displace") {
      const dx = wp.x - prev.x, dy = wp.y - prev.y;
      const n = Math.floor(Math.hypot(dx, dy) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push({ pos: { ...wp, x: prev.x + dx * t, y: prev.y + dy * t }, index, sampled: true });
      }
    }
    out.push({ pos: wp, index, sampled: false });
    prev = wp;
  });
  return out;
}
