/**
 * The trigger engine.
 *
 * Triggers live on a tile as flags["dxcufgbs-tile-triggers"].triggers (an array). What a trigger has
 * already fired for lives in flags["dxcufgbs-tile-triggers"].state[triggerId] = {count, tokens: {id: true}}.
 *
 * Movement triggers are detected on the client that moves the token (in preMoveToken, where the path
 * is known before the token moves). When a token would walk past a tile whose "enter" trigger stops
 * movement, the move is cancelled and re-issued so it ends on the first space inside the tile. Once
 * the move is accepted (moveToken) the events are handed to the active GM, who waits until the token
 * has visibly reached the tile and then runs the actions. All actions run on the active GM's client.
 *
 * What another client sends over the socket is not trusted: the active GM takes the sender from Foundry
 * (never from the message), checks the event and the token against the sender, and re-checks the
 * trigger's conditions unless a GM forced the fire (see handleFire).
 */

import { MODULE_ID, SOCKET, EVENTS, defaultTrigger } from "./constants.js";
import { tokenInside, tokenInRange, samplePath } from "./geometry.js";
import { runActions } from "./actions.js";
import { isDisarmed } from "./disarm.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* -------------------------------------------- */
/*  Reading triggers                            */
/* -------------------------------------------- */

export function isEnabled() {
  return game.settings.get(MODULE_ID, "enabled");
}

/** A tile's triggers, with defaults filled in. */
export function getTriggers(tile) {
  const list = tile?.flags?.[MODULE_ID]?.triggers;
  if (!Array.isArray(list)) return [];
  return list.map(t => ({ ...defaultTrigger(), ...foundry.utils.deepClone(t), id: t.id ?? foundry.utils.randomID() }));
}

export function getState(tile) {
  return tile?.flags?.[MODULE_ID]?.state ?? {};
}

/**
 * Can the tile's triggers fire automatically? Not when its triggers are switched off ("Triggers on this
 * tile are active" unticked) or when it is disarmed. GM-forced manual fires ignore this.
 */
export function tileActive(tile) {
  return tile?.flags?.[MODULE_ID]?.disabled !== true && !isDisarmed(tile);
}

/** Tiles on a scene that have at least one trigger. */
export function triggerTiles(scene) {
  return scene?.tiles.filter(t => getTriggers(t).length) ?? [];
}

/** Find a trigger on a tile by id or (case-insensitive) name. */
export function findTrigger(tile, ref) {
  const list = getTriggers(tile);
  if (!ref) return null;
  const low = String(ref).toLowerCase();
  return list.find(t => t.id === ref) ?? list.find(t => (t.name ?? "").toLowerCase() === low) ?? null;
}

/* -------------------------------------------- */
/*  Conditions                                  */
/* -------------------------------------------- */

/** Does this token count for the trigger ("Applies to")? */
export function tokenMatches(trigger, token) {
  if (!token) return true;
  if (trigger.ignoreHidden && token.hidden) return false;
  const actor = token.actor;
  switch (trigger.appliesTo) {
    case "players": return !!actor?.hasPlayerOwner;
    case "npcs": return !actor?.hasPlayerOwner;
    case "actors": {
      const ids = new Set(trigger.actors ?? []);
      return [actor?.uuid, token.baseActor?.uuid, token.actorId && `Actor.${token.actorId}`, token.uuid].some(u => u && ids.has(u));
    }
    default: return true;
  }
}

function inCombat(token, scene) {
  if (!token) return !!game.combats.find(c => c.started && c.scene?.id === scene?.id);
  return !!game.combats.find(c => c.started && c.combatants.some(cb => cb.tokenId === token.id && cb.sceneId === token.parent?.id));
}

/** `scene` is the tile's scene: without a token, "in combat" means a combat has started there. */
function combatOk(trigger, token, scene) {
  if (trigger.combat === "in") return inCombat(token, scene);
  if (trigger.combat === "out") return !inCombat(token, scene);
  return true;
}

const inflight = new Set();
const flightKey = (tile, trigger, token, perToken) => `${tile.uuid}|${trigger.id}${perToken ? `|${token?.id}` : ""}`;

function frequencyOk(tile, trigger, token) {
  const st = getState(tile)[trigger.id];
  if (trigger.frequency === "once") return !(st?.count > 0) && !inflight.has(flightKey(tile, trigger));
  if (trigger.frequency === "oncePerToken") {
    if (!token) return true;
    return !st?.tokens?.[token.id] && !inflight.has(flightKey(tile, trigger, token, true));
  }
  return true;
}

/**
 * Should this trigger fire for this token right now? Rolls the trigger's chance when `roll` is set,
 * so call it once per event.
 */
export function shouldFire(tile, trigger, token, { roll = true } = {}) {
  if (!isEnabled() || !trigger.enabled || !tileActive(tile)) return false;
  if (!tokenMatches(trigger, token)) return false;
  if (!combatOk(trigger, token, tile.parent)) return false;
  if (!frequencyOk(tile, trigger, token)) return false;
  if (roll && Number(trigger.chance) < 100 && Math.random() * 100 >= Number(trigger.chance)) return false;
  return true;
}

/* -------------------------------------------- */
/*  Movement                                    */
/* -------------------------------------------- */

/** Pending events per movement id, sent to the GM once the move is accepted. */
const pendingMoves = new Map();

/**
 * Work out which movement triggers this move sets off, and where (if anywhere) it must be cut short.
 * @returns {{events: object[], cut: number|null, samples: object[]}|null}
 */
export function analyzeMovement(token, move) {
  const scene = token.parent;
  const tiles = scene.tiles.filter(t => tileActive(t) && getTriggers(t).some(tr => tr.enabled && EVENTS[tr.event]?.movement));
  if (!tiles.length) return null;

  const samples = samplePath(token, move.origin, move.passed.waypoints);
  const final = move.pending.waypoints.length === 0;
  const insideCache = new Map();
  const inside = (tile, detection) => {
    const key = `${tile.id}|${detection}`;
    if (!insideCache.has(key)) insideCache.set(key, samples.map(s => tokenInside(tile, token, s.pos, detection)));
    return insideCache.get(key);
  };

  // Enter / exit candidates, in path order
  const candidates = [];
  for (const tile of tiles) {
    for (const trigger of getTriggers(tile)) {
      if (!trigger.enabled || !["enter", "exit"].includes(trigger.event)) continue;
      const ins = inside(tile, trigger.detection);
      for (let i = 1; i < samples.length; i++) {
        const ev = !ins[i - 1] && ins[i] ? "enter" : (ins[i - 1] && !ins[i] ? "exit" : null);
        if (ev === trigger.event) candidates.push({ tile, trigger, i });
      }
    }
  }
  candidates.sort((a, b) => a.i - b.i);

  const events = [];
  const seen = new Set();
  let cut = null;
  for (const c of candidates) {
    if (cut !== null && c.i > cut) break;
    const key = `${c.tile.id}|${c.trigger.id}`;
    if (c.trigger.frequency !== "always" && seen.has(key)) continue;
    if (!shouldFire(c.tile, c.trigger, token)) continue;
    seen.add(key);
    events.push({ tileId: c.tile.id, triggerId: c.trigger.id, event: c.trigger.event });
    const last = c.i === samples.length - 1;
    const teleport = samples[c.i].pos.action === "displace";
    if (c.trigger.event === "enter" && c.trigger.stopMovement && !last && !teleport) cut = c.i;
  }

  // "Ends movement in tile": where the token comes to rest (the cut, or the end of the whole move)
  const restIndex = cut ?? (final ? samples.length - 1 : null);
  if (restIndex !== null) {
    for (const tile of tiles) {
      for (const trigger of getTriggers(tile)) {
        if (!trigger.enabled || trigger.event !== "stop") continue;
        if (!inside(tile, trigger.detection)[restIndex]) continue;
        if (!shouldFire(tile, trigger, token)) continue;
        events.push({ tileId: tile.id, triggerId: trigger.id, event: "stop" });
      }
    }
  }
  return { events, cut, samples };
}

const WAYPOINT_KEYS = ["x", "y", "elevation", "width", "height", "shape", "action", "snapped", "explicit", "checkpoint"];
const cleanWaypoint = w => Object.fromEntries(WAYPOINT_KEYS.filter(k => w[k] !== undefined).map(k => [k, w[k]]));

/** The move's waypoints up to (and ending at) sample `cut`. */
function truncatedWaypoints(samples, cut, waypoints) {
  const s = samples[cut];
  const keep = [];
  for (let j = 0; j < s.index; j++) if (!waypoints[j].intermediate) keep.push(cleanWaypoint(waypoints[j]));
  keep.push({ ...cleanWaypoint(s.pos), explicit: true, checkpoint: true });
  return keep;
}

function onPreMoveToken(token, move, options) {
  if (!isEnabled()) return;
  if (options.isUndo || options.isPaste || move.method === "undo" || move.method === "paste") return;
  const mine = options[MODULE_ID];
  if (mine?.events) {
    if (mine.events.length) pendingMoves.set(move.id, mine.events);
    return;
  }
  let result;
  try { result = analyzeMovement(token, move); }
  catch (err) { console.error(`${MODULE_ID} | movement analysis failed`, err); return; }
  if (!result) return;

  if (result.cut !== null) {
    const waypoints = truncatedWaypoints(result.samples, result.cut, move.passed.waypoints);
    const events = result.events;
    const opts = {
      method: move.method,
      autoRotate: move.autoRotate,
      showRuler: move.showRuler,
      [MODULE_ID]: { events }
    };
    if (move.constrainOptions) opts.constrainOptions = foundry.utils.deepClone(move.constrainOptions);
    // Re-issue after this update has been rejected
    setTimeout(() => token.move(waypoints, opts).catch(err => console.error(`${MODULE_ID} | re-issued move failed`, err)), 0);
    return false;
  }
  if (result.events.length) pendingMoves.set(move.id, result.events);
}

function onMoveToken(token, movement) {
  const events = pendingMoves.get(movement.id);
  if (!events) return;
  pendingMoves.delete(movement.id);
  for (const e of events) {
    dispatch({ sceneId: token.parent.id, tileId: e.tileId, triggerId: e.triggerId, event: e.event, tokenId: token.id });
  }
}

/* -------------------------------------------- */
/*  Combat turns                                */
/* -------------------------------------------- */

/** Fire every trigger of `event` on tiles the token stands in (GM only). */
export function fireForToken(token, event) {
  if (!token?.parent) return;
  for (const tile of token.parent.tiles) {
    for (const trigger of getTriggers(tile)) {
      if (trigger.event !== event) continue;
      if (!tokenInside(tile, token, token, trigger.detection)) continue;
      if (!shouldFire(tile, trigger, token)) continue;
      dispatch({ sceneId: token.parent.id, tileId: tile.id, triggerId: trigger.id, event, tokenId: token.id });
    }
  }
}

function onCombatTurnChange(combat, prior, current) {
  if (!game.user.isActiveGM || !isEnabled()) return;
  const prev = prior?.combatantId ? combat.combatants.get(prior.combatantId) : null;
  const cur = current?.combatantId ? combat.combatants.get(current.combatantId) : null;
  if (prev?.token && prior.combatantId !== current?.combatantId) fireForToken(prev.token, "turnEnd");
  if (cur?.token) fireForToken(cur.token, "turnStart");
}

/* -------------------------------------------- */
/*  Dispatch to the GM                          */
/* -------------------------------------------- */

let warnedNoGM = 0;

/**
 * Hand an event to the active GM (or run it here if we are the active GM). The active GM learns who
 * sent it from Foundry, so the payload carries no user.
 */
export function dispatch(payload) {
  if (game.user.isActiveGM) return handleFire(payload, game.user);
  if (!game.users.activeGM) {
    if (Date.now() - warnedNoGM > 30000) {
      warnedNoGM = Date.now();
      ui.notifications.warn("DXTT.Notify.NoGM", { localize: true });
    }
    return;
  }
  game.socket.emit(SOCKET, { type: "fire", ...payload });
}

/** Wait until the token has visibly arrived where the event happens. */
async function waitForArrival(token, tile, trigger, event) {
  await sleep(30);
  const obj = token.object;
  if (!obj || window.document.hidden) return;
  const anim = obj.movementAnimationPromise;
  if (!anim) return;
  let done = false;
  anim.then(() => { done = true; }, () => { done = true; });
  const start = performance.now();
  if (event === "stop") {
    await Promise.race([anim, sleep(15000)]);
    return;
  }
  const want = event === "enter";
  while (!done && performance.now() - start < 15000) {
    const pos = { x: obj.x, y: obj.y, width: token.width, height: token.height, shape: token.shape };
    if (tokenInside(tile, token, pos, trigger.detection) === want) return;
    await sleep(30);
  }
}

/** Runaway guard: a token that sets off triggers in a loop (e.g. teleporting between two tiles). */
const recentFires = new Map();
function runaway(tokenId) {
  if (!tokenId) return false;
  const now = Date.now();
  const list = (recentFires.get(tokenId) ?? []).filter(t => now - t < 3000);
  list.push(now);
  recentFires.set(tokenId, list);
  return list.length > 15;
}

/**
 * May `sender` set off this trigger with this event and token? The payload is whatever the sending client
 * chose, so everything in it is checked here, on the active GM.
 * - `force` counts only from a GM. A GM-forced manual fire skips the conditions (disarmed and switched-off
 *   tiles too), as the ▶ button and api.fire always did.
 * - The event must be the trigger's own one; only a GM may fire any trigger as "manual".
 * - Players: combat turn events never come from them (the active GM finds those itself). Movement and click
 *   events need a token, and any token must be one the player owns; a click must be within the trigger's
 *   click range.
 * - Unless forced, the trigger's conditions are checked again (enabled, tile active, "Applies to", combat,
 *   frequency). The chance was rolled once by the client that saw the event and is not rolled again.
 * @returns {boolean}
 */
function fireAllowed(sender, tile, trigger, event, token, force) {
  const gm = sender.isGM;
  if (typeof event !== "string" || !Object.hasOwn(EVENTS, event)) return false;
  if (event !== trigger.event && !(gm && event === "manual")) return false;
  if (!gm) {
    if (event === "turnStart" || event === "turnEnd") return false;
    if ((EVENTS[event].movement || event === "click") && !token) return false;
    if (token && !token.testUserPermission(sender, "OWNER")) return false;
    if (event === "click" && !tokenInRange(token, tile, trigger.clickRange)) return false;
  }
  if (gm && force === true) return true;
  return shouldFire(tile, trigger, token, { roll: false });
}

/**
 * Active GM: validate and run a fired trigger.
 * @param {object} payload   {sceneId, tileId, triggerId, event, tokenId, force} as the sender sent it
 * @param {User} sender      who sent it, as Foundry reports it (game.user for our own events)
 */
async function handleFire({ sceneId, tileId, triggerId, event, tokenId = null, force = false } = {}, sender) {
  if (!sender) return;
  const scene = game.scenes.get(sceneId);
  const tile = scene?.tiles.get(tileId);
  const trigger = tile ? getTriggers(tile).find(t => t.id === triggerId) : null;
  if (!tile || !trigger) return;
  if (tokenId !== null && typeof tokenId !== "string") return;
  const token = tokenId ? scene.tokens.get(tokenId) ?? null : null;
  // The token must be on the tile's scene. Only a GM's manual fire runs without it, as it always did.
  if (tokenId && !token && !(sender.isGM && event === "manual")) return;
  if (!fireAllowed(sender, tile, trigger, event, token, force)) {
    console.debug(`${MODULE_ID} | refused a "${event}" fire of trigger ${triggerId} from ${sender.name}`);
    return;
  }
  if (runaway(tokenId)) {
    ui.notifications.warn(game.i18n.format("DXTT.Notify.Runaway", { token: token?.name ?? "?" }));
    return;
  }
  const perToken = trigger.frequency === "oncePerToken";
  const key = flightKey(tile, trigger, token, perToken);
  inflight.add(key);
  try {
    if (token && EVENTS[event]?.movement) await waitForArrival(token, tile, trigger, event);
    await recordFired(tile, trigger, token);
    await execute(tile, trigger, { token, user: sender, event });
  } finally {
    inflight.delete(key);
  }
}

async function recordFired(tile, trigger, token) {
  const st = getState(tile)[trigger.id] ?? {};
  const path = `flags.${MODULE_ID}.state.${trigger.id}`;
  const update = { [`${path}.count`]: (st.count ?? 0) + 1 };
  if (token) update[`${path}.tokens.${token.id}`] = true;
  await tile.update(update, { render: false, [MODULE_ID]: { state: true } });
}

/** Run a trigger's actions. */
export async function execute(tile, trigger, { token = null, user = game.user, event = "manual" } = {}) {
  const ctx = {
    tile, trigger, token, actor: token?.actor ?? null, user, event,
    scene: tile.parent, depth: 0, vars: {}
  };
  Hooks.callAll(`${MODULE_ID}.fire`, ctx);
  await runActions(trigger.actions, ctx);
}

/** Clear what a trigger (or all triggers of a tile) has fired for. */
export async function resetState(tile, triggerId = null) {
  if (triggerId) return tile.update({ [`flags.${MODULE_ID}.state.-=${triggerId}`]: null });
  return tile.update({ [`flags.${MODULE_ID}.-=state`]: null });
}

/**
 * Fire a trigger by hand (button in the editor, API, macro). The GM can force it past its conditions.
 * @param {TileDocument|string} tileRef  a tile or its UUID
 * @param {string} triggerRef            trigger id or name
 * @param {object} [opts]
 * @param {TokenDocument|Token|string} [opts.token]  the token that "set it off"
 * @param {boolean} [opts.force=true]    ignore the trigger's conditions (GM only)
 * @returns {Promise<boolean>}  false when it does not fire. A player can only fire "Manual / macro only"
 *                              triggers, never forced, and only with no token or a token they own.
 */
export async function fire(tileRef, triggerRef, { token = null, force = true } = {}) {
  const tile = typeof tileRef === "string" ? await fromUuid(tileRef) : tileRef?.document ?? tileRef;
  const trigger = findTrigger(tile, triggerRef);
  if (!tile || !trigger) throw new Error(`${MODULE_ID} | trigger "${triggerRef}" not found`);
  if (typeof token === "string") token = await fromUuid(token);
  token = token?.document ?? token;
  // Players can fire "Manual / macro only" triggers only, with no token or a token they own (the GM checks it again)
  if (!game.user.isGM && (trigger.event !== "manual" || (token && !token.isOwner))) return false;
  if (!(force && game.user.isGM) && !shouldFire(tile, trigger, token)) return false;
  dispatch({ sceneId: tile.parent.id, tileId: tile.id, triggerId: trigger.id, event: "manual", tokenId: token?.id ?? null, force: force && game.user.isGM });
  return true;
}

/* -------------------------------------------- */
/*  Socket                                      */
/* -------------------------------------------- */

let warnedNoSender = false;

/**
 * Who sent a socket message. Foundry's server adds the id of the emitting user after the arguments the
 * client emitted (socketlib relies on the same). Our messages are one argument, so exactly one more is
 * expected: a client that adds arguments of its own (to pose as someone else) gets more than one, and a
 * message without a sender is refused rather than trusted.
 */
function socketSender(extra) {
  const id = extra.length === 1 ? extra[0] : null;
  const user = typeof id === "string" ? game.users.get(id) ?? null : null;
  if (!user && !warnedNoSender) {
    warnedNoSender = true;
    console.warn(`${MODULE_ID} | ignored a socket message without a known sender`);
  }
  return user;
}

function onSocket(msg, ...extra) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "fire": {
      if (!game.user.isActiveGM) return;
      const sender = socketSender(extra);
      if (sender) handleFire(msg, sender);
      break;
    }
    case "pan": {
      // Only a GM's client sends this (the "Pan camera" action)
      if (!socketSender(extra)?.isGM) return;
      if (Array.isArray(msg.users) && msg.users.length && !msg.users.includes(game.user.id)) return;
      const { x, y } = msg;
      const scale = Number(msg.scale) || 0;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;
      if (canvas.scene?.id === msg.sceneId) canvas.animatePan({ x, y, scale: scale || undefined, duration: 800 });
      break;
    }
  }
}

export function registerEngine() {
  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("combatTurnChange", onCombatTurnChange);
  game.socket.on(SOCKET, onSocket);
}
