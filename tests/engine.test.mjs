// Unit tests for the round events (scripts/engine.js), run with `node --test tests/` (CI: the "lint" step).
// Foundry's globals are stubbed with just what the engine reads; dispatched fires are caught on the socket.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const MODULE_ID = "dxcufgbs-tile-triggers";
const emitted = [];
let nextId = 0;
const id = prefix => `${prefix}${++nextId}`;

Math.clamp ??= (n, min, max) => Math.min(Math.max(n, min), max);
globalThis.foundry = { utils: { deepClone: v => structuredClone(v), randomID: () => id("r"), isEmpty: o => !Object.keys(o ?? {}).length } };
globalThis.game = {
  settings: { get: () => true },
  user: { isActiveGM: false, isGM: true },
  users: { activeGM: { id: "gm" } },
  socket: { emit: (_channel, msg) => emitted.push(msg), on() {} },
  combats: [],
  scenes: new Map(),
  i18n: { localize: k => k, format: k => k }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.Hooks = { on() {}, once() {}, callAll() {} };

const { fireRoundEvents, inCombat, combatScenes, roundEventsPassed, initiativeSlot } = await import("../scripts/engine.js");

/** An array with get(id), like a Foundry collection. */
const collection = items => Object.assign(items, { get: key => items.find(i => i.id === key) });

function makeScene() {
  const scene = { id: id("Scene"), tiles: collection([]), tokens: collection([]) };
  game.scenes.set(scene.id, scene);
  return scene;
}

function addTile(scene, trigger) {
  const tile = {
    id: id("Tile"), parent: scene,
    flags: { [MODULE_ID]: { triggers: [{ id: id("trig"), event: "roundStart", combat: "in", requireToken: false, ...trigger }] } }
  };
  tile.uuid = `Scene.${scene.id}.Tile.${tile.id}`;
  scene.tiles.push(tile);
  return tile;
}

function addToken(scene) {
  const token = { id: id("Token"), parent: scene, hidden: false, actor: null };
  scene.tokens.push(token);
  return token;
}

/** A started combat. `linked` is the scene it is linked to (null: unlinked, Foundry's default). */
function makeCombat({ linked = null, tokens = [], initiatives = [] } = {}) {
  const combatants = tokens.map((token, i) => ({
    id: id("Combatant"), tokenId: token?.id ?? null, sceneId: token?.parent?.id ?? null,
    token: token ?? null, initiative: initiatives[i] ?? 10 - i
  }));
  const combat = { id: id("Combat"), started: true, scene: linked, combatants: collection(combatants), turns: [...combatants] };
  game.combats.push(combat);
  return combat;
}

/** Fired tile ids, in order. */
const fired = () => emitted.filter(m => m.type === "fire").map(m => m.tileId);
const start = { round: 0, turn: 0 };
const r1 = { round: 1, turn: 0 };

beforeEach(() => {
  emitted.length = 0;
  game.combats.length = 0;
});

/* ---------------- the bug, and the fix ---------------- */

test("linked combat: round start fires for a tile on its scene", () => {
  const scene = makeScene();
  const tile = addTile(scene);
  const combat = makeCombat({ linked: scene, tokens: [addToken(scene)] });
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), [tile.id]);
  assert.equal(emitted[0].sceneId, scene.id);
});

test("unlinked combat whose combatants are on the tile's scene: round start fires", () => {
  const scene = makeScene();
  const tile = addTile(scene);
  const combat = makeCombat({ tokens: [addToken(scene), addToken(scene)] });
  assert.equal(combat.scene, null);
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), [tile.id]);
  assert.equal(emitted[0].sceneId, scene.id);
});

test("unlinked combat: initiative count fires too", () => {
  const scene = makeScene();
  const tile = addTile(scene, { event: "initiative", initiative: 20 });
  const combat = makeCombat({ tokens: [addToken(scene), addToken(scene)], initiatives: [22, 15] });
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), []); // count 20 comes after the 22, before the 15
  fireRoundEvents(combat, r1, { round: 1, turn: 1 });
  assert.deepEqual(fired(), [tile.id]);
});

test("unlinked combat on another scene does NOT fire the tile's triggers", () => {
  const tileScene = makeScene(), otherScene = makeScene();
  addTile(tileScene);
  addToken(tileScene); // a token on the tile's scene that is not in the combat
  const combat = makeCombat({ tokens: [addToken(otherScene)] });
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), []);
});

test("combat with combatants on two scenes fires each scene's round triggers once per round", () => {
  const a = makeScene(), b = makeScene();
  const tileA = addTile(a), tileB = addTile(b);
  const combat = makeCombat({ tokens: [addToken(a), addToken(b), addToken(a)] });
  assert.deepEqual(combatScenes(combat).map(s => s.id), [a.id, b.id]);
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired().sort(), [tileA.id, tileB.id].sort());
  const sceneOf = Object.fromEntries(emitted.map(m => [m.tileId, m.sceneId]));
  assert.equal(sceneOf[tileA.id], a.id);
  assert.equal(sceneOf[tileB.id], b.id);
  // Later turns in the same round, and stepping back and forward, fire nothing
  fireRoundEvents(combat, r1, { round: 1, turn: 1 });
  fireRoundEvents(combat, { round: 1, turn: 1 }, { round: 1, turn: 2 });
  fireRoundEvents(combat, { round: 2, turn: 0 }, { round: 1, turn: 2 });
  assert.equal(fired().length, 2);
  // Next round: once each again
  fireRoundEvents(combat, { round: 1, turn: 2 }, { round: 2, turn: 0 });
  assert.equal(fired().length, 4);
  assert.deepEqual(fired().slice(2).sort(), [tileA.id, tileB.id].sort());
});

test("combatants without a token count for no scene", () => {
  const scene = makeScene();
  addTile(scene);
  const combat = makeCombat({ tokens: [null] });
  assert.deepEqual(combatScenes(combat), []);
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), []);
});

test("a combat that has not started fires nothing", () => {
  const scene = makeScene();
  addTile(scene);
  const combat = makeCombat({ tokens: [addToken(scene)] });
  combat.started = false;
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), []);
});

test("a combat restarted from round 0 fires round 1 again", () => {
  const scene = makeScene();
  const tile = addTile(scene);
  const combat = makeCombat({ tokens: [addToken(scene)] });
  fireRoundEvents(combat, start, r1);
  fireRoundEvents(combat, start, r1);
  assert.deepEqual(fired(), [tile.id, tile.id]);
});

/* ---------------- inCombat(null, scene) ---------------- */

test("inCombat(null, scene): linked combat", () => {
  const scene = makeScene(), other = makeScene();
  makeCombat({ linked: scene });
  assert.equal(inCombat(null, scene), true);
  assert.equal(inCombat(null, other), false);
});

test("inCombat(null, scene): unlinked combat with a combatant on the scene", () => {
  const scene = makeScene();
  makeCombat({ tokens: [addToken(scene)] });
  assert.equal(inCombat(null, scene), true);
});

test("inCombat(null, scene): unlinked combat on another scene", () => {
  const scene = makeScene(), other = makeScene();
  makeCombat({ tokens: [addToken(other)] });
  assert.equal(inCombat(null, scene), false);
  assert.equal(inCombat(null, other), true);
});

test("inCombat(null, scene): combatants on two scenes", () => {
  const a = makeScene(), b = makeScene(), c = makeScene();
  makeCombat({ tokens: [addToken(a), addToken(b)] });
  assert.equal(inCombat(null, a), true);
  assert.equal(inCombat(null, b), true);
  assert.equal(inCombat(null, c), false);
});

test("inCombat(null, scene): unstarted combats and tokenless combatants don't count", () => {
  const scene = makeScene();
  makeCombat({ tokens: [addToken(scene)] }).started = false;
  makeCombat({ tokens: [null] });
  assert.equal(inCombat(null, scene), false);
});

test("inCombat(token): movement / turn checks still go through the token", () => {
  const scene = makeScene();
  const inIt = addToken(scene), outOfIt = addToken(scene);
  makeCombat({ tokens: [inIt] });
  assert.equal(inCombat(inIt, scene), true);
  assert.equal(inCombat(outOfIt, scene), false);
});

/* ---------------- roundEventsPassed / initiativeSlot ---------------- */

test("initiativeSlot: ties go after the combatants on the count", () => {
  const turns = [{ initiative: 22 }, { initiative: 20 }, { initiative: 15 }];
  assert.equal(initiativeSlot(turns, 20), 2);
  assert.equal(initiativeSlot(turns, 25), 0);
  assert.equal(initiativeSlot(turns, 10), 3);
  assert.equal(initiativeSlot([{ initiative: null }], 20), null);
});

test("roundEventsPassed: round start and initiative counts, once per trigger", () => {
  const wanted = [{ event: "roundStart" }, { event: "initiative", count: 20 }];
  const slot = () => 1;
  assert.deepEqual(roundEventsPassed({ round: 0, turn: 0 }, { round: 1, turn: 0 }, 3, slot, wanted).map(p => p.index), [0]);
  assert.deepEqual(roundEventsPassed({ round: 1, turn: 0 }, { round: 1, turn: 1 }, 3, slot, wanted).map(p => p.index), [1]);
  assert.deepEqual(roundEventsPassed({ round: 1, turn: 2 }, { round: 2, turn: 1 }, 3, slot, wanted).map(p => [p.index, p.round]), [[0, 2], [1, 2]]);
  // Skipping several rounds: only the latest counts
  assert.deepEqual(roundEventsPassed({ round: 1, turn: 0 }, { round: 4, turn: 0 }, 3, slot, wanted).map(p => [p.index, p.round]), [[1, 3], [0, 4]]);
  // Going back fires nothing
  assert.deepEqual(roundEventsPassed({ round: 2, turn: 0 }, { round: 1, turn: 2 }, 3, slot, wanted), []);
});
