/**
 * The actions a trigger can run. Each action type is described once here: the fields the editor
 * shows for it and what it does when it runs. All actions run on the active GM's client.
 *
 * Other modules can add their own with game.modules.get("dxcufgbs-tile-triggers").api.registerAction(type, def).
 *
 * def = {
 *   label, icon, group,
 *   fields: [{key, type, label, hint, default, options, docTypes, fileType, min, max, step, showIf(action)}],
 *                                    // options: an object, or a function (context) => object
 *   branches: true|false,            // has "on success" / "on failure" action lists (action.success /
 *                                    // action.fail); run() runs them itself, e.g. with api.runActions
 *   run: async (action, ctx) => {},  // ctx = {tile, trigger, token, actor, user, event, scene, depth, vars,
 *                                    //        patch} (patch: the last random patch, see the effect action)
 *   summary: (action, context) => string  // short text for the collapsed card
 * }
 *
 * The editor calls options() and summary() with context = {tile, scene}: the tile being edited and its scene.
 *
 * Field types: text, textarea, number, select, checkbox, formula, file, doc (one UUID), docs (UUIDs).
 */

import { MODULE_ID, QUERY_ROLL, SOCKET, MAX_DEPTH } from "./constants.js";
import { tileContains, tokenInside, centerAt } from "./geometry.js";
import { isDisarmed, setDisarmed } from "./disarm.js";
import { SHAKE_STRENGTHS, shakeAmplitude, shakeSeconds, shakeCanvas } from "./shake.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const L = key => game.i18n.localize(key);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

export const ACTIONS = {};

/* -------------------------------------------- */
/*  Running                                     */
/* -------------------------------------------- */

/** Fill in defaults for an action. */
export function normalizeAction(a) {
  const def = ACTIONS[a?.type];
  const out = { id: a?.id ?? foundry.utils.randomID(), type: a?.type, disabled: !!a?.disabled };
  for (const f of def?.fields ?? []) out[f.key] = a?.[f.key] ?? foundry.utils.deepClone(f.default ?? (f.type === "docs" ? [] : ""));
  if (def?.branches) {
    out.success = Array.isArray(a?.success) ? a.success : [];
    out.fail = Array.isArray(a?.fail) ? a.fail : [];
  }
  return out;
}

export function newAction(type) {
  return normalizeAction({ type });
}

/** Run a list of actions one after another. */
export async function runActions(list, ctx) {
  if (!Array.isArray(list) || ctx.depth > MAX_DEPTH + 2) return;
  for (const raw of list) {
    if (!raw || raw.disabled) continue;
    const def = ACTIONS[raw.type];
    if (!def) {
      console.warn(`${MODULE_ID} | unknown action type "${raw.type}"`);
      continue;
    }
    const action = normalizeAction(raw);
    try {
      await def.run(action, ctx);
    } catch (err) {
      console.error(`${MODULE_ID} | action "${raw.type}" failed`, err);
      ui.notifications.error(game.i18n.format("DXTT.Notify.ActionFailed", { action: L(def.label), error: err.message }));
    }
    if (ctx.stop) break;
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

export function tileName(tile) {
  return tile?.flags?.[MODULE_ID]?.name || L("DXTT.TileUnnamed");
}

/** Users that own an actor. */
export function ownersOf(actor, { active = true, players = true } = {}) {
  if (!actor) return [];
  return game.users.filter(u => (!players || !u.isGM) && (!active || u.active) && actor.testUserPermission(u, "OWNER"));
}

/** The player who should roll for an actor: whoever has it as their character, else any active owner. */
function rollUser(actor) {
  const owners = ownersOf(actor);
  return owners.find(u => u.character?.id === actor.id) ?? owners[0] ?? null;
}

/**
 * Replace {token}, {actor}, {player}, {user}, {tile}, {trigger}, {scene}, {total}, {dc}, {result} in a text.
 * The values are HTML-escaped, unless `escape` is false for a text that is escaped as a whole later.
 */
export function fmt(text, ctx, extra = {}, { escape = true } = {}) {
  const players = ownersOf(ctx.actor, { active: false }).map(u => u.name).join(", ");
  const map = {
    token: ctx.token?.name ?? "",
    actor: ctx.actor?.name ?? ctx.token?.name ?? "",
    player: players || ctx.user?.name || "",
    user: ctx.user?.name ?? "",
    tile: tileName(ctx.tile),
    trigger: ctx.trigger?.name ?? "",
    scene: ctx.scene?.name ?? "",
    ...ctx.vars,
    ...extra
  };
  return String(text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in map ? (escape ? esc(map[k]) : String(map[k] ?? "")) : m));
}

/** The tokens an action works on. */
export function resolveTargets(action, ctx) {
  switch (action.target) {
    case "inside":
      return ctx.scene.tokens.filter(t => tokenInside(ctx.tile, t, t, ctx.trigger?.detection));
    case "picked":
      return (Array.isArray(action.targetTokens) ? action.targetTokens : [])
        .map(u => (typeof u === "string" ? fromUuidSync(u) : null)).filter(d => d?.documentName === "Token");
    case "patch": {
      const patch = validPatch(ctx.patch);
      if (!patch) return [];
      return ctx.scene.tokens.filter(t => tokenInside(patch, t, t, ctx.trigger?.detection));
    }
    case "trigger":
    default:
      return ctx.token ? [ctx.token] : [];
  }
}

function docCenter(doc) {
  if (!doc) return null;
  if (doc.object?.center) return { x: doc.object.center.x, y: doc.object.center.y };
  if (doc.documentName === "Token") {
    const g = doc.parent.grid;
    return { x: doc.x + (doc.width * g.sizeX) / 2, y: doc.y + (doc.height * g.sizeY) / 2 };
  }
  if ("width" in doc && "height" in doc) return { x: doc.x + doc.width / 2, y: doc.y + doc.height / 2 };
  return { x: doc.x, y: doc.y };
}

/* ---- Random patch ---- */

/** A random patch as stored in ctx.patch, checked: {x, y, width, height} in scene pixels, or null. */
export function validPatch(p) {
  if (!p || typeof p !== "object") return null;
  const { x, y, width, height } = p;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  // The same shape a tile has, so the tile geometry helpers work on it (an unrotated rectangle)
  return { x, y, width, height, rotation: 0, flags: {} };
}

/** A patch size in grid spaces: a whole number from 1 to 50. */
const patchSquares = v => Math.clamp(Math.round(Number(v)) || 1, 1, 50);

/**
 * A random grid-aligned patch of w × h spaces that lies wholly inside the tile's area (rotation and ellipse
 * included), or null when none fits. The tile's area is convex, so a patch whose four corners are inside it is
 * inside it.
 */
export function randomPatch(tile, scene, w, h, random = Math.random) {
  const g = scene.grid;
  const sx = g.sizeX ?? g.size, sy = g.sizeY ?? g.size;
  const W = patchSquares(w) * sx, H = patchSquares(h) * sy;
  const tw = Math.abs(tile.width), th = Math.abs(tile.height);
  const cx = tile.x + tw / 2, cy = tile.y + th / 2;
  const r = Math.toRadians(tile.rotation || 0), c = Math.cos(r), s = Math.sin(r);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: cx + (a * tw / 2) * c - (b * th / 2) * s, y: cy + (a * tw / 2) * s + (b * th / 2) * c }));
  const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
  const start = g.isGridless ? { x: minX, y: minY } : g.getSnappedPoint({ x: minX, y: minY }, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
  const e = 0.5;
  const inside = (x, y) => [[x + e, y + e], [x + W - e, y + e], [x + W - e, y + H - e], [x + e, y + H - e]].every(([px, py]) => tileContains(tile, { x: px, y: py }));
  // Pick one of the places that fit, each equally likely, without listing them all (reservoir sampling)
  let pick = null, n = 0;
  for (let x = start.x; x + W <= maxX + e; x += sx) {
    for (let y = start.y; y + H <= maxY + e; y += sy) {
      if (inside(x, y) && random() * ++n < 1) pick = { x, y, width: W, height: H };
    }
  }
  return pick;
}

const speakerFor = (action, ctx) => (action.speaker === "token" && ctx.token
  ? ChatMessage.getSpeaker({ token: ctx.token })
  : { alias: fmt(action.alias, ctx) || L("DXTT.Narrator") });

/** Recipients for "who" fields. */
function recipients(who, ctx) {
  switch (who) {
    case "gm": return game.users.filter(u => u.isGM).map(u => u.id);
    case "owners": {
      const ids = new Set(ownersOf(ctx.actor, { active: false }).map(u => u.id));
      if (!ids.size && ctx.user && !ctx.user.isGM) ids.add(ctx.user.id);
      return [...ids];
    }
    case "players": return game.users.filter(u => !u.isGM).map(u => u.id);
    default: return game.users.map(u => u.id);
  }
}

function abilityOptions() {
  const abil = CONFIG.DND5E?.abilities;
  if (abil) return Object.fromEntries(Object.entries(abil).map(([k, v]) => [k, v.label ?? k]));
  return { str: "STR", dex: "DEX", con: "CON", int: "INT", wis: "WIS", cha: "CHA" };
}
function skillOptions() {
  const sk = CONFIG.DND5E?.skills;
  return sk ? Object.fromEntries(Object.entries(sk).map(([k, v]) => [k, v.label ?? k])) : {};
}
function damageTypeOptions() {
  const out = { "": "DXTT.Option.Untyped" };
  for (const src of [CONFIG.DND5E?.damageTypes, CONFIG.DND5E?.healingTypes]) {
    for (const [k, v] of Object.entries(src ?? {})) if (!k.startsWith("midi")) out[k] = v.label ?? k;
  }
  return out;
}
export function statusOptions() {
  return Object.fromEntries(CONFIG.statusEffects.map(s => [s.id, s.name ?? s.label ?? s.id]));
}

/** Apply damage (or healing, with a healing type) to an actor. */
async function applyDamage(actor, amount, type) {
  if (!actor || !amount) return;
  if (typeof actor.applyDamage === "function") return actor.applyDamage([{ value: amount, type: type || undefined }], {});
  ui.notifications.warn(L("DXTT.Notify.NoDamageSupport"));
}

/* -------------------------------------------- */
/*  Rolls                                       */
/* -------------------------------------------- */

export function rollLabel(spec) {
  switch (spec.kind) {
    case "save": return game.i18n.format("DXTT.Roll.Save", { ability: abilityOptions()[spec.ability] ?? spec.ability });
    case "ability": return game.i18n.format("DXTT.Roll.Check", { ability: abilityOptions()[spec.ability] ?? spec.ability });
    case "skill": return game.i18n.format("DXTT.Roll.Skill", { skill: skillOptions()[spec.skill] ?? spec.skill });
    default: return spec.formula || "1d20";
  }
}

/** Roll for an actor (on whichever client calls it). choice: "normal" | "adv" | "dis". */
export async function rollFor(actor, spec, choice = "normal") {
  const cfg = {};
  if (choice === "adv") cfg.advantage = true;
  if (choice === "dis") cfg.disadvantage = true;
  if (spec.showDC && Number.isFinite(Number(spec.dc))) cfg.target = Number(spec.dc);
  const dialog = { configure: false };
  let rolls = null;
  if (spec.kind === "save" && typeof actor.rollSavingThrow === "function") rolls = await actor.rollSavingThrow({ ability: spec.ability, ...cfg }, dialog, {});
  else if (spec.kind === "ability" && typeof actor.rollAbilityCheck === "function") rolls = await actor.rollAbilityCheck({ ability: spec.ability, ...cfg }, dialog, {});
  else if (spec.kind === "skill" && typeof actor.rollSkill === "function") rolls = await actor.rollSkill({ skill: spec.skill, ...cfg }, dialog, {});
  else {
    let formula = spec.kind === "formula" && spec.formula ? spec.formula : "1d20";
    if (choice === "adv") formula = formula.replace(/\b1d20\b/, "2d20kh");
    if (choice === "dis") formula = formula.replace(/\b1d20\b/, "2d20kl");
    const roll = await new Roll(formula, actor.getRollData()).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: rollLabel(spec) });
    return { total: roll.total };
  }
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  return roll ? { total: roll.total } : null;
}

const ROLL_KINDS = ["save", "ability", "skill", "formula"];

/**
 * The roll request as the player's client uses it: only known fields, of the right types. It comes from
 * another client (see main.js), so nothing in it is used as it was sent.
 */
export function cleanRollSpec(spec) {
  if (!spec || typeof spec !== "object") return null;
  const str = v => (typeof v === "string" ? v : "");
  const timeout = Number(spec.timeout);
  return {
    kind: ROLL_KINDS.includes(spec.kind) ? spec.kind : "formula",
    ability: str(spec.ability), skill: str(spec.skill), formula: str(spec.formula),
    dc: Number(spec.dc), showDC: spec.showDC === true, message: str(spec.message),
    timeout: Number.isFinite(timeout) ? Math.clamp(timeout, 10, 300) : 60
  };
}

/**
 * Player side: show the roll prompt and roll. Registered as a user query (see main.js). `spec.message`
 * is plain text (placeholders filled in, nothing escaped yet): everything shown here is escaped.
 */
export async function promptRoll(actor, spec) {
  spec = cleanRollSpec(spec);
  if (!spec) return null;
  const id = `dxtt-roll-${foundry.utils.randomID()}`;
  const dc = spec.showDC ? ` ${game.i18n.format("DXTT.Roll.DC", { dc: spec.dc })}` : "";
  const content = `<div class="dxtt-roll-prompt">
    ${actor.img ? `<img src="${esc(actor.img)}" alt="">` : ""}
    <div>${spec.message ? `<p class="dxtt-roll-msg">${esc(spec.message)}</p>` : ""}
    <p>${game.i18n.format("DXTT.Roll.Prompt", { actor: `<strong>${esc(actor.name)}</strong>`, roll: `<strong>${esc(rollLabel(spec))}${esc(dc)}</strong>` })}</p></div>
  </div>`;
  const waiting = foundry.applications.api.DialogV2.wait({
    id,
    classes: ["dxtt-roll-dialog"],
    window: { title: L("DXTT.Roll.Title"), icon: "fa-solid fa-dice-d20" },
    position: { width: 440 },
    content,
    rejectClose: false,
    buttons: [
      { action: "dis", label: "DXTT.Roll.Disadvantage", icon: "fa-solid fa-angles-down" },
      { action: "normal", label: "DXTT.Roll.Roll", icon: "fa-solid fa-dice-d20", default: true },
      { action: "adv", label: "DXTT.Roll.Advantage", icon: "fa-solid fa-angles-up" }
    ]
  });
  const ms = (Number(spec.timeout) || 60) * 1000;
  const timer = setTimeout(() => foundry.applications.instances.get(id)?.close(), ms);
  const choice = await waiting;
  clearTimeout(timer);
  if (!choice) return null;
  return rollFor(actor, spec, choice);
}

/** GM side: have the token's player roll (or roll for them). */
async function requestRoll(token, spec, mode) {
  const actor = token.actor;
  if (mode !== "auto") {
    const user = rollUser(actor);
    if (user) {
      try {
        const res = await user.query(QUERY_ROLL, { actorUuid: actor.uuid, spec }, { timeout: (spec.timeout + 10) * 1000 });
        if (res && Number.isFinite(res.total)) return res;
      } catch (err) {
        console.warn(`${MODULE_ID} | roll request to ${user.name} failed, rolling for them`, err);
      }
    }
  }
  return rollFor(actor, spec, "normal");
}

/* -------------------------------------------- */
/*  Field presets                               */
/* -------------------------------------------- */

export const TARGETS = {
  trigger: "DXTT.Option.TargetTrigger", inside: "DXTT.Option.TargetInside", picked: "DXTT.Option.TargetPicked",
  patch: "DXTT.Option.TargetPatch"
};

const TARGET_FIELDS = [
  { key: "target", type: "select", label: "DXTT.Field.Target", default: "trigger", hint: "DXTT.Field.TargetHint", options: TARGETS },
  { key: "targetTokens", type: "docs", label: "DXTT.Field.Tokens", docTypes: ["Token"], showIf: a => a.target === "picked" }
];

const WHO = { owners: "DXTT.Option.WhoOwners", players: "DXTT.Option.WhoPlayers", all: "DXTT.Option.WhoAll", gm: "DXTT.Option.WhoGM" };

/* -------------------------------------------- */
/*  Action types                                */
/* -------------------------------------------- */

export function registerAction(type, def) {
  ACTIONS[type] = { group: "other", icon: "fa-solid fa-gear", fields: [], branches: false, ...def };
}

/* ---- Rolls ---- */

registerAction("check", {
  label: "DXTT.Action.check", icon: "fa-solid fa-dice-d20", group: "rolls", branches: true,
  fields: [
    { key: "kind", type: "select", label: "DXTT.Field.RollKind", default: "save",
      options: { save: "DXTT.Option.Save", ability: "DXTT.Option.AbilityCheck", skill: "DXTT.Option.SkillCheck", formula: "DXTT.Option.Formula" } },
    { key: "ability", type: "select", label: "DXTT.Field.Ability", default: "dex", options: abilityOptions, showIf: a => ["save", "ability"].includes(a.kind) },
    { key: "skill", type: "select", label: "DXTT.Field.Skill", default: "prc", options: skillOptions, showIf: a => a.kind === "skill" },
    { key: "formula", type: "formula", label: "DXTT.Field.Formula", default: "1d20 + @abilities.dex.mod", showIf: a => a.kind === "formula" },
    { key: "dc", type: "number", label: "DXTT.Field.DC", default: 15, min: 0, step: 1 },
    { key: "showDC", type: "checkbox", label: "DXTT.Field.ShowDC", default: false },
    { key: "mode", type: "select", label: "DXTT.Field.RollMode", default: "prompt",
      options: { prompt: "DXTT.Option.PromptPlayer", auto: "DXTT.Option.RollAuto" } },
    { key: "message", type: "text", label: "DXTT.Field.PromptText", default: "", placeholder: "DXTT.Placeholder.PromptText" },
    ...TARGET_FIELDS,
    { key: "damage", type: "formula", label: "DXTT.Field.DamageOnFail", default: "", placeholder: "2d10" },
    { key: "damageType", type: "select", label: "DXTT.Field.DamageType", default: "", options: damageTypeOptions, showIf: a => !!a.damage },
    { key: "onSuccess", type: "select", label: "DXTT.Field.OnSuccessDamage", default: "half", showIf: a => !!a.damage,
      options: { half: "DXTT.Option.Half", none: "DXTT.Option.None", full: "DXTT.Option.Full" } },
    { key: "failStatus", type: "select", label: "DXTT.Field.FailStatus", default: "", options: () => ({ "": "DXTT.Option.None", ...statusOptions() }) },
    { key: "gmSummary", type: "checkbox", label: "DXTT.Field.GMSummary", default: true }
  ],
  summary: a => `${rollLabel(a)} · DC ${a.dc}`,
  async run(action, ctx) {
    const tokens = resolveTargets(action, ctx).filter(t => t.actor);
    if (!tokens.length) return;
    const spec = {
      kind: action.kind, ability: action.ability, skill: action.skill, formula: action.formula,
      // Plain text: the player's prompt escapes it (promptRoll)
      dc: Number(action.dc), showDC: !!action.showDC, message: fmt(action.message, ctx, {}, { escape: false }),
      timeout: game.settings.get(MODULE_ID, "promptTimeout")
    };
    const results = await Promise.all(tokens.map(t => requestRoll(t, spec, action.mode)));

    let dmg = null;
    if (String(action.damage ?? "").trim()) {
      dmg = await new Roll(action.damage, tokens[0].actor.getRollData()).evaluate();
      const typeLabel = damageTypeOptions()[action.damageType];
      await dmg.toMessage({
        speaker: { alias: tileName(ctx.tile) },
        flavor: `${esc(ctx.trigger?.name || tileName(ctx.tile))}${action.damageType ? ` · ${esc(L(typeLabel))}` : ""}`
      });
    }

    const lines = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], res = results[i];
      const success = !!res && res.total >= spec.dc;
      let dealt = 0;
      if (dmg) {
        dealt = success ? ({ half: Math.floor(dmg.total / 2), full: dmg.total }[action.onSuccess] ?? 0) : dmg.total;
        if (dealt > 0) await applyDamage(token.actor, dealt, action.damageType);
      }
      if (!success && action.failStatus) await token.actor.toggleStatusEffect(action.failStatus, { active: true });
      lines.push(`<li><strong>${esc(token.name)}</strong>: ${res ? res.total : "—"} ${success ? "✔" : "✘"}${dealt ? ` · ${dealt} ${esc(L("DXTT.Damage"))}` : ""}</li>`);
      const sub = {
        ...ctx, token, actor: token.actor, depth: ctx.depth + 1,
        vars: { ...ctx.vars, total: res?.total ?? "", dc: spec.dc, result: L(success ? "DXTT.Success" : "DXTT.Failure") }
      };
      await runActions(success ? action.success : action.fail, sub);
      // Later actions in the same list can use the (last) result too
      Object.assign(ctx.vars, { total: res?.total ?? "", dc: spec.dc, result: sub.vars.result });
    }
    if (action.gmSummary) {
      await ChatMessage.create({
        content: `<div class="dxtt-chat"><p><i class="fa-solid fa-bolt"></i> ${esc(ctx.trigger?.name || tileName(ctx.tile))} · ${esc(rollLabel(spec))} DC ${spec.dc}</p><ul>${lines.join("")}</ul></div>`,
        whisper: game.users.filter(u => u.isGM).map(u => u.id),
        speaker: { alias: L("DXTT.Title") }
      });
    }
  }
});

registerAction("damage", {
  label: "DXTT.Action.damage", icon: "fa-solid fa-heart-crack", group: "rolls",
  fields: [
    { key: "formula", type: "formula", label: "DXTT.Field.Formula", default: "1d6" },
    { key: "damageType", type: "select", label: "DXTT.Field.DamageType", default: "", options: damageTypeOptions },
    ...TARGET_FIELDS,
    { key: "perTarget", type: "checkbox", label: "DXTT.Field.PerTarget", default: false }
  ],
  summary: a => `${a.formula} ${a.damageType ?? ""}`,
  async run(action, ctx) {
    const tokens = resolveTargets(action, ctx).filter(t => t.actor);
    if (!tokens.length) return;
    let shared = null;
    for (const token of tokens) {
      let roll = shared;
      if (!roll) {
        roll = await new Roll(action.formula, token.actor.getRollData()).evaluate();
        const typeLabel = damageTypeOptions()[action.damageType];
        await roll.toMessage({
          speaker: { alias: tileName(ctx.tile) },
          flavor: `${esc(action.perTarget ? token.name : (ctx.trigger?.name || tileName(ctx.tile)))}${action.damageType ? ` · ${esc(L(typeLabel))}` : ""}`
        });
        if (!action.perTarget) shared = roll;
      }
      await applyDamage(token.actor, roll.total, action.damageType);
    }
  }
});

registerAction("status", {
  label: "DXTT.Action.status", icon: "fa-solid fa-person-falling-burst", group: "rolls",
  fields: [
    { key: "status", type: "select", label: "DXTT.Field.Status", default: "prone", options: statusOptions },
    { key: "mode", type: "select", label: "DXTT.Field.Mode", default: "add",
      options: { add: "DXTT.Option.Add", remove: "DXTT.Option.Remove", toggle: "DXTT.Option.Toggle" } },
    ...TARGET_FIELDS
  ],
  summary: a => `${L({ add: "DXTT.Option.Add", remove: "DXTT.Option.Remove", toggle: "DXTT.Option.Toggle" }[a.mode])}: ${statusOptions()[a.status] ?? a.status}`,
  async run(action, ctx) {
    for (const token of resolveTargets(action, ctx)) {
      if (!token.actor) continue;
      const opts = action.mode === "toggle" ? {} : { active: action.mode === "add" };
      await token.actor.toggleStatusEffect(action.status, opts);
    }
  }
});

/* ---- Scene ---- */

const HIDEABLE = ["Token", "Tile", "AmbientLight", "AmbientSound", "Drawing"];

registerAction("reveal", {
  label: "DXTT.Action.reveal", icon: "fa-solid fa-eye", group: "scene",
  fields: [
    { key: "docs", type: "docs", label: "DXTT.Field.Things", docTypes: HIDEABLE },
    { key: "mode", type: "select", label: "DXTT.Field.Mode", default: "show",
      options: { show: "DXTT.Option.Show", hide: "DXTT.Option.Hide", toggle: "DXTT.Option.Toggle" } }
  ],
  summary: a => `${L({ show: "DXTT.Option.Show", hide: "DXTT.Option.Hide", toggle: "DXTT.Option.Toggle" }[a.mode])} ×${a.docs?.length ?? 0}`,
  async run(action, ctx) {
    for (const uuid of action.docs ?? []) {
      const doc = fromUuidSync(uuid);
      if (!doc || !("hidden" in doc)) continue;
      const hidden = action.mode === "toggle" ? !doc.hidden : action.mode === "hide";
      if (doc.hidden !== hidden) await doc.update({ hidden });
    }
  }
});

registerAction("door", {
  label: "DXTT.Action.door", icon: "fa-solid fa-door-open", group: "scene",
  fields: [
    { key: "docs", type: "docs", label: "DXTT.Field.Doors", docTypes: ["Wall"] },
    { key: "state", type: "select", label: "DXTT.Field.DoorState", default: "open",
      options: { open: "DXTT.Option.Open", closed: "DXTT.Option.Closed", locked: "DXTT.Option.Locked", toggle: "DXTT.Option.Toggle" } }
  ],
  summary: a => `${L({ open: "DXTT.Option.Open", closed: "DXTT.Option.Closed", locked: "DXTT.Option.Locked", toggle: "DXTT.Option.Toggle" }[a.state])} ×${a.docs?.length ?? 0}`,
  async run(action) {
    const S = CONST.WALL_DOOR_STATES;
    for (const uuid of action.docs ?? []) {
      const wall = fromUuidSync(uuid);
      if (!wall || !wall.door) continue;
      const ds = action.state === "toggle" ? (wall.ds === S.OPEN ? S.CLOSED : S.OPEN)
        : { open: S.OPEN, closed: S.CLOSED, locked: S.LOCKED }[action.state];
      if (wall.ds !== ds) await wall.update({ ds });
    }
  }
});

registerAction("teleport", {
  label: "DXTT.Action.teleport", icon: "fa-solid fa-person-through-window", group: "scene",
  fields: [
    { key: "destination", type: "doc", label: "DXTT.Field.Destination", docTypes: ["Tile"] },
    ...TARGET_FIELDS,
    { key: "pull", type: "checkbox", label: "DXTT.Field.PullPlayers", default: true }
  ],
  summary: a => fromUuidSync(a.destination) ? tileName(fromUuidSync(a.destination)) : "—",
  async run(action, ctx) {
    const dest = fromUuidSync(action.destination);
    if (!dest) throw new Error(L("DXTT.Notify.NoDestination"));
    const scene = dest.parent;
    const tokens = resolveTargets(action, ctx);
    const spots = freeSpots(dest, scene, tokens);
    for (const [i, token] of tokens.entries()) {
      const pos = spots[i % spots.length](token);
      if (token.parent === scene) {
        await token.move({ x: pos.x, y: pos.y, elevation: token.elevation, action: "displace" });
        continue;
      }
      const data = token.toObject();
      data.x = pos.x;
      data.y = pos.y;
      if (scene.tokens.has(token.id)) delete data._id;
      const created = await CONFIG.Token.documentClass.create(data, { parent: scene, keepId: !!data._id });
      if (!created) continue;
      const viewers = ownersOf(token.actor).filter(u => u.viewedScene === token.parent.id);
      await token.delete();
      if (action.pull) for (const u of viewers) game.socket.emit("pullToScene", scene.id, u.id);
    }
  }
});

/** Places inside a destination tile, closest to its centre first. Returns position makers per token. */
function freeSpots(tile, scene, moving) {
  const g = scene.grid;
  const s = g.size;
  const movingIds = new Set(moving.map(t => t.id));
  const occupied = scene.tokens.filter(t => !movingIds.has(t.id)).map(t => ({ x: t.x, y: t.y }));
  const c = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  const makers = [];
  const start = g.isGridless ? { x: tile.x, y: tile.y } : g.getSnappedPoint({ x: tile.x, y: tile.y }, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
  const cells = [];
  for (let x = start.x; x < tile.x + tile.width; x += s) {
    for (let y = start.y; y < tile.y + tile.height; y += s) {
      if (!tileContains(tile, { x: x + s / 2, y: y + s / 2 })) continue;
      if (occupied.some(o => Math.abs(o.x - x) < 1 && Math.abs(o.y - y) < 1)) continue;
      cells.push({ x, y, d: Math.hypot(x + s / 2 - c.x, y + s / 2 - c.y) });
    }
  }
  cells.sort((a, b) => a.d - b.d);
  for (const cell of cells) makers.push(() => ({ x: cell.x, y: cell.y }));
  if (!makers.length) {
    makers.push(token => {
      const p = { x: c.x - (token.width * g.sizeX) / 2, y: c.y - (token.height * g.sizeY) / 2 };
      return g.isGridless ? p : g.getSnappedPoint(p, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
    });
  }
  return makers;
}

registerAction("tileImage", {
  label: "DXTT.Action.tileImage", icon: "fa-solid fa-image", group: "scene",
  fields: [
    { key: "tile", type: "doc", label: "DXTT.Field.TileThisDefault", docTypes: ["Tile"] },
    { key: "src", type: "file", label: "DXTT.Field.Image", fileType: "imagevideo", default: "" }
  ],
  summary: a => (a.src || "").split("/").pop(),
  async run(action, ctx) {
    const tile = action.tile ? fromUuidSync(action.tile) : ctx.tile;
    if (tile && action.src) await tile.update({ "texture.src": action.src });
  }
});

registerAction("pan", {
  label: "DXTT.Action.pan", icon: "fa-solid fa-camera", group: "scene",
  fields: [
    { key: "location", type: "select", label: "DXTT.Field.PanTo", default: "token",
      options: { token: "DXTT.Option.TriggerToken", tile: "DXTT.Option.ThisTile", doc: "DXTT.Option.Picked" } },
    { key: "doc", type: "doc", label: "DXTT.Field.Target", docTypes: ["Token", "Tile", "AmbientLight", "AmbientSound", "Note", "Drawing", "Wall"], showIf: a => a.location === "doc" },
    { key: "scale", type: "number", label: "DXTT.Field.Zoom", default: 0, min: 0, max: 3, step: 0.1 },
    { key: "who", type: "select", label: "DXTT.Field.Who", default: "owners", options: WHO }
  ],
  summary: a => L(WHO[a.who]),
  async run(action, ctx) {
    const target = action.location === "tile" ? ctx.tile : action.location === "doc" ? fromUuidSync(action.doc) : ctx.token;
    const p = docCenter(target ?? ctx.tile);
    if (!p) return;
    const users = recipients(action.who, ctx);
    const scale = Number(action.scale) || 0;
    game.socket.emit(SOCKET, { type: "pan", sceneId: ctx.scene.id, x: p.x, y: p.y, scale, users });
    if (users.includes(game.user.id) && canvas.scene?.id === ctx.scene.id) canvas.animatePan({ x: p.x, y: p.y, scale: scale || undefined, duration: 800 });
  }
});

/* ---- Push token ---- */

export const PUSH_DIRECTIONS = {
  awayTile: "DXTT.Option.PushAwayTile", towardTile: "DXTT.Option.PushTowardTile",
  towardDoc: "DXTT.Option.PushTowardDoc", awayDoc: "DXTT.Option.PushAwayDoc",
  awayToken: "DXTT.Option.PushAwayToken", compass: "DXTT.Option.PushCompass"
};
export const COMPASS = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
const COMPASS_LABELS = Object.fromEntries(Object.keys(COMPASS).map(k => [k, `DXTT.Compass.${k}`]));
const PUSH_DOC_TYPES = ["Token", "Tile", "Note"];
const PUSH_MAX = 20;

/** Push distance in grid spaces: a whole number from 1 to 20. */
const pushSquares = v => Math.clamp(Math.round(Number(v)) || 1, 1, PUSH_MAX);

/** The centre of a token, at its position or another one. */
const tokenCenter = (token, pos = token) => centerAt(token, { x: pos.x, y: pos.y, elevation: token.elevation, width: token.width, height: token.height, shape: token.shape });

/** The picked document of a push, if it is a token, tile or note on this scene. */
function pushDoc(action, ctx) {
  if (typeof action.doc !== "string" || !action.doc) return null;
  const doc = fromUuidSync(action.doc);
  return doc && PUSH_DOC_TYPES.includes(doc.documentName) && doc.parent === ctx.scene ? doc : null;
}

/**
 * Does a wall stop movement from a to b? On the scene the client views, the move collision backend decides
 * (one-way walls, door states, wall types). On another scene (the GM may view a different one) there is no
 * canvas, so the scene's walls are checked as lines: any wall that blocks movement, except open doors.
 */
export function wallBlocks(scene, a, b) {
  if (canvas?.ready && canvas.scene === scene) {
    return !!CONFIG.Canvas.polygonBackends.move.testCollision(a, b, { type: "move", mode: "any" });
  }
  const NONE = CONST.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  for (const w of scene.walls ?? []) {
    if (w.move === NONE) continue;
    if (w.door && w.ds === CONST.WALL_DOOR_STATES.OPEN) continue;
    const [x0, y0, x1, y1] = w.c;
    if (foundry.utils.lineSegmentIntersects(a, b, { x: x0, y: y0 }, { x: x1, y: y1 })) return true;
  }
  return false;
}

/** One grid step in the direction of `dir`: on square grids one of the 8 neighbours, else one grid size along it. */
function gridStep(grid, dir) {
  const len = Math.hypot(dir.x, dir.y);
  if (!(len > 1e-6)) return null;
  if (grid.isSquare) {
    const oct = Math.round(Math.atan2(dir.y, dir.x) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: Math.round(Math.cos(oct)) * grid.sizeX, y: Math.round(Math.sin(oct)) * grid.sizeY };
  }
  return { x: (dir.x / len) * grid.size, y: (dir.y / len) * grid.size };
}

/**
 * The path of one pushed token: positions (top-left), one per grid space, ending on the last free space before
 * a wall or an occupied space. `source` is the point to push away from or toward, or null for a compass push.
 * @param {TokenDocument} token
 * @param {{mode:"away"|"toward"|"compass", source:{x,y}|null, compass:number[]|null, squares:number}} push
 * @param {(pos:{x,y}) => boolean} occupied   is the token's footprint at this position taken?
 */
export function pushPath(token, push, occupied) {
  const scene = token.parent;
  const g = scene.grid;
  const c0 = tokenCenter(token);
  let c = c0;
  const path = [];
  const dist = p => Math.hypot(p.x - push.source.x, p.y - push.source.y);
  for (let i = 0; i < push.squares; i++) {
    let dir;
    if (push.mode === "compass") dir = { x: push.compass[0], y: push.compass[1] };
    else if (push.mode === "away") dir = { x: c.x - push.source.x, y: c.y - push.source.y };
    else dir = { x: push.source.x - c.x, y: push.source.y - c.y };
    const step = gridStep(g, dir);
    if (!step) break;
    let next = { x: c.x + step.x, y: c.y + step.y };
    if (!g.isGridless && !g.isSquare) next = g.getCenterPoint(next);
    if (Math.hypot(next.x - c.x, next.y - c.y) < 1) break;
    // Toward something: never past it
    if (push.mode === "toward" && dist(next) >= dist(c)) break;
    if (wallBlocks(scene, c, next)) break;
    // The token keeps its alignment to the grid: it moves by as much as its centre does
    const pos = { x: token.x + next.x - c0.x, y: token.y + next.y - c0.y };
    if (occupied(pos)) break;
    path.push(pos);
    c = next;
  }
  return path;
}

/**
 * Resolves true when the token's next move has happened on this client, false after `ms` or when cancelled.
 * @returns {Promise<boolean> & {cancel: () => void}}
 */
function nextMoveOf(token, ms = 3000) {
  let done, id, timer;
  const promise = new Promise(resolve => {
    done = value => { Hooks.off("moveToken", id); clearTimeout(timer); resolve(value); };
  });
  id = Hooks.on("moveToken", doc => { if (doc === token) done(true); });
  timer = setTimeout(() => done(false), ms);
  promise.cancel = () => done(false);
  return promise;
}

/** Do two token footprints overlap (by more than a pixel)? */
function footprintsOverlap(a, b) {
  return a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
}

registerAction("push", {
  label: "DXTT.Action.push", icon: "fa-solid fa-hand-back-fist", group: "rolls",
  fields: [
    ...TARGET_FIELDS,
    { key: "distance", type: "number", label: "DXTT.Field.PushDistance", default: 1, min: 1, max: PUSH_MAX, step: 1 },
    { key: "direction", type: "select", label: "DXTT.Field.PushDirection", hint: "DXTT.Field.PushDirectionHint", default: "awayTile", options: PUSH_DIRECTIONS },
    { key: "doc", type: "doc", label: "DXTT.Field.PushDoc", docTypes: PUSH_DOC_TYPES, showIf: a => ["towardDoc", "awayDoc"].includes(a.direction) },
    { key: "compass", type: "select", label: "DXTT.Field.Compass", default: "n", options: COMPASS_LABELS, showIf: a => a.direction === "compass" }
  ],
  summary: a => {
    const dir = a.direction === "compass" ? L(COMPASS_LABELS[a.compass] ?? COMPASS_LABELS.n) : L(PUSH_DIRECTIONS[a.direction] ?? PUSH_DIRECTIONS.awayTile);
    return `${pushSquares(a.distance)} · ${dir}`;
  },
  async run(action, ctx) {
    const direction = Object.hasOwn(PUSH_DIRECTIONS, action.direction) ? action.direction : "awayTile";
    const squares = pushSquares(action.distance);
    let mode = "away", source = null, compass = null;
    switch (direction) {
      case "awayTile": source = docCenter(ctx.tile); break;
      case "towardTile": mode = "toward"; source = docCenter(ctx.tile); break;
      case "awayDoc":
      case "towardDoc": {
        const doc = pushDoc(action, ctx);
        if (!doc) { console.warn(`${MODULE_ID} | push: the picked token, tile or note is missing or on another scene`); return; }
        mode = direction === "towardDoc" ? "toward" : "away";
        source = docCenter(doc);
        break;
      }
      case "awayToken":
        if (!ctx.token || ctx.token.parent !== ctx.scene) { console.warn(`${MODULE_ID} | push: there is no triggering token to push away from`); return; }
        source = tokenCenter(ctx.token);
        break;
      case "compass":
        mode = "compass";
        compass = COMPASS[action.compass] ?? COMPASS.n;
        break;
    }
    if (source && !(Number.isFinite(source.x) && Number.isFinite(source.y))) return;

    // Only tokens on this scene, never the token pushed away from
    const tokens = resolveTargets(action, ctx).filter(t => t.parent === ctx.scene && !(direction === "awayToken" && t === ctx.token));
    if (!tokens.length) return;
    // Those in front move first, so they don't block the ones behind them
    const key = t => {
      const p = tokenCenter(t);
      if (mode === "compass") return -(p.x * compass[0] + p.y * compass[1]);
      const d = Math.hypot(p.x - source.x, p.y - source.y);
      return mode === "away" ? -d : d;
    };
    tokens.sort((a, b) => key(a) - key(b));

    const g = ctx.scene.grid;
    const footprint = (t, pos = t) => ({ x: pos.x, y: pos.y, w: t.width * g.sizeX, h: t.height * g.sizeY });
    // Where the tokens pushed so far stand (or may stand): token id -> positions
    const planned = new Map();
    for (const token of tokens) {
      const others = ctx.scene.tokens.filter(t => t !== token)
        .flatMap(t => (planned.get(t.id) ?? [t]).map(p => footprint(t, p)));
      const occupied = pos => others.some(o => footprintsOverlap(footprint(token, pos), o));
      const path = pushPath(token, { mode, source, compass, squares }, occupied);
      if (!path.length) continue;
      // A normal move (no "displace"), so the tiles it crosses fire their enter / leave / stop triggers.
      // A trigger with "Stop movement" cancels it and re-issues it shorter: then wait for that move to land.
      const landed = nextMoveOf(token);
      const moved = await token.move(path.map(p => ({ x: p.x, y: p.y })), { method: "api" });
      if (moved !== false) { landed.cancel(); planned.set(token.id, [path.at(-1)]); continue; }
      // Where it ended, or (no move came) anywhere on the path, so no later token is pushed onto it
      planned.set(token.id, (await landed) ? [{ x: token.x, y: token.y }] : [{ x: token.x, y: token.y }, ...path]);
    }
  }
});

/* ---- Screen shake ---- */

const SHAKE_LABELS = { low: "DXTT.Option.ShakeLow", medium: "DXTT.Option.ShakeMedium", high: "DXTT.Option.ShakeHigh", custom: "DXTT.Option.ShakeCustom" };

registerAction("shake", {
  label: "DXTT.Action.shake", icon: "fa-solid fa-house-crack", group: "scene",
  fields: [
    { key: "strength", type: "select", label: "DXTT.Field.ShakeStrength", default: "medium", options: SHAKE_LABELS },
    { key: "amount", type: "number", label: "DXTT.Field.ShakeAmount", hint: "DXTT.Field.ShakeAmountHint", default: SHAKE_STRENGTHS.medium, min: 1, max: 100, step: 1,
      showIf: a => a.strength === "custom" },
    { key: "seconds", type: "number", label: "DXTT.Field.Seconds", default: 1, min: 0.1, max: 10, step: 0.1 },
    { key: "who", type: "select", label: "DXTT.Field.Who", default: "all", options: WHO }
  ],
  summary: a => `${a.strength === "custom" ? shakeAmplitude(a) : L(SHAKE_LABELS[a.strength] ?? SHAKE_LABELS.medium)} · ${shakeSeconds(a.seconds)}s · ${L(WHO[a.who] ?? WHO.all)}`,
  async run(action, ctx) {
    const users = recipients(Object.hasOwn(WHO, action.who) ? action.who : "all", ctx);
    if (!users.length) return;
    const amplitude = shakeAmplitude(action), seconds = shakeSeconds(action.seconds);
    game.socket.emit(SOCKET, { type: "shake", sceneId: ctx.scene.id, amplitude, seconds, users });
    if (users.includes(game.user.id) && canvas.scene?.id === ctx.scene.id) shakeCanvas(amplitude, seconds);
  }
});

registerAction("effect", {
  label: "DXTT.Action.effect", icon: "fa-solid fa-wand-sparkles", group: "scene",
  fields: [
    { key: "file", type: "file", label: "DXTT.Field.EffectFile", fileType: "imagevideo", default: "" },
    { key: "at", type: "select", label: "DXTT.Field.At", default: "token",
      options: { token: "DXTT.Option.TriggerToken", tile: "DXTT.Option.ThisTile", patch: "DXTT.Option.RandomPatch" } },
    { key: "patchWidth", type: "number", label: "DXTT.Field.PatchWidth", hint: "DXTT.Field.PatchHint", default: 4, min: 1, max: 50, step: 1, showIf: a => a.at === "patch" },
    { key: "patchHeight", type: "number", label: "DXTT.Field.PatchHeight", default: 4, min: 1, max: 50, step: 1, showIf: a => a.at === "patch" },
    { key: "scale", type: "number", label: "DXTT.Field.Scale", default: 1, min: 0.1, max: 10, step: 0.1 },
    { key: "below", type: "checkbox", label: "DXTT.Field.BelowTokens", default: false }
  ],
  summary: a => {
    const file = (a.file || "").split("/").pop();
    return a.at === "patch" ? `${patchSquares(a.patchWidth)} × ${patchSquares(a.patchHeight)}${file ? ` · ${file}` : ""}` : file;
  },
  async run(action, ctx) {
    // The patch is picked even without Sequencer or a file, so later actions can still target it
    let patch = null;
    if (action.at === "patch") {
      patch = randomPatch(ctx.tile, ctx.scene, action.patchWidth, action.patchHeight);
      ctx.patch = patch;
      if (!patch) {
        console.warn(`${MODULE_ID} | no ${patchSquares(action.patchWidth)} × ${patchSquares(action.patchHeight)} patch fits inside the tile "${tileName(ctx.tile)}"`);
        return;
      }
    }
    if (!action.file) return;
    const Seq = globalThis.Sequence;
    if (!Seq || !game.modules.get("sequencer")?.active) {
      ui.notifications.warn(L("DXTT.Notify.NoSequencer"));
      return;
    }
    const scale = Number(action.scale) || 1;
    const seq = new Seq();
    const fx = seq.effect().file(action.file);
    if (patch) fx.atLocation({ x: patch.x + patch.width / 2, y: patch.y + patch.height / 2 }).size({ width: patch.width * scale, height: patch.height * scale });
    else if (action.at === "token" && ctx.token) fx.atLocation(ctx.token).scaleToObject(scale);
    else fx.atLocation(docCenter(ctx.tile)).size({ width: ctx.tile.width * scale, height: ctx.tile.height * scale });
    if (action.below) fx.belowTokens();
    await seq.play();
  }
});

/* ---- Game & chat ---- */

registerAction("pause", {
  label: "DXTT.Action.pause", icon: "fa-solid fa-pause", group: "game",
  fields: [
    { key: "mode", type: "select", label: "DXTT.Field.Mode", default: "pause", options: { pause: "DXTT.Option.Pause", unpause: "DXTT.Option.Unpause" } }
  ],
  summary: a => L(a.mode === "unpause" ? "DXTT.Option.Unpause" : "DXTT.Option.Pause"),
  async run(action) {
    game.togglePause(action.mode !== "unpause", { broadcast: true });
  }
});

registerAction("chat", {
  label: "DXTT.Action.chat", icon: "fa-solid fa-comment", group: "game",
  fields: [
    { key: "who", type: "select", label: "DXTT.Field.SendTo", default: "gm",
      options: { gm: "DXTT.Option.WhisperGM", owners: "DXTT.Option.WhisperOwners", all: "DXTT.Option.Public" } },
    { key: "content", type: "textarea", label: "DXTT.Field.Message", default: "", placeholder: "DXTT.Placeholder.Message" },
    { key: "speaker", type: "select", label: "DXTT.Field.Speaker", default: "narrator", options: { narrator: "DXTT.Option.Narrator", token: "DXTT.Option.TriggerToken" } },
    { key: "alias", type: "text", label: "DXTT.Field.Alias", default: "", showIf: a => a.speaker !== "token" }
  ],
  summary: a => `${L({ gm: "DXTT.Option.WhisperGM", owners: "DXTT.Option.WhisperOwners", all: "DXTT.Option.Public" }[a.who])}: ${String(a.content ?? "").replace(/<[^>]+>/g, "").slice(0, 40)}`,
  async run(action, ctx) {
    const content = fmt(action.content, ctx).replace(/\n/g, "<br>");
    if (!content.trim()) return;
    const data = { content: `<div class="dxtt-chat">${content}</div>`, speaker: speakerFor(action, ctx) };
    if (action.who === "gm") data.whisper = recipients("gm", ctx);
    else if (action.who === "owners") data.whisper = [...new Set([...recipients("owners", ctx), ...recipients("gm", ctx)])];
    await ChatMessage.create(data);
  }
});

registerAction("sound", {
  label: "DXTT.Action.sound", icon: "fa-solid fa-volume-high", group: "game",
  fields: [
    { key: "src", type: "file", label: "DXTT.Field.Sound", fileType: "audio", default: "" },
    { key: "volume", type: "number", label: "DXTT.Field.Volume", default: 0.8, min: 0, max: 1, step: 0.05 },
    { key: "who", type: "select", label: "DXTT.Field.Who", default: "all", options: WHO }
  ],
  summary: a => (a.src || "").split("/").pop(),
  async run(action, ctx) {
    if (!action.src) return;
    const vol = Number(action.volume);
    const data = { src: action.src, volume: Number.isFinite(vol) ? vol : 0.8, autoplay: true, loop: false };
    const users = recipients(action.who, ctx);
    const others = users.filter(id => id !== game.user.id);
    if (users.includes(game.user.id)) foundry.audio.AudioHelper.play(data, false);
    if (others.length) foundry.audio.AudioHelper.play(data, { recipients: others });
  }
});

registerAction("journal", {
  label: "DXTT.Action.journal", icon: "fa-solid fa-book-open", group: "game",
  fields: [
    { key: "doc", type: "doc", label: "DXTT.Field.Journal", docTypes: ["JournalEntry", "JournalEntryPage"] },
    { key: "who", type: "select", label: "DXTT.Field.Who", default: "owners", options: { owners: "DXTT.Option.WhoOwners", all: "DXTT.Option.WhoAll" } }
  ],
  summary: a => fromUuidSync(a.doc)?.name ?? "—",
  async run(action, ctx) {
    const doc = await fromUuid(action.doc);
    if (!doc) return;
    const users = action.who === "all" ? [] : recipients("owners", ctx);
    await foundry.documents.collections.Journal.show(doc, { force: true, users });
  }
});

registerAction("table", {
  label: "DXTT.Action.table", icon: "fa-solid fa-table-list", group: "game",
  fields: [
    { key: "doc", type: "doc", label: "DXTT.Field.Table", docTypes: ["RollTable"] },
    { key: "rollMode", type: "select", label: "DXTT.Field.Visibility", default: "gmroll",
      options: { publicroll: "CHAT.RollPublic", gmroll: "CHAT.RollPrivate", blindroll: "CHAT.RollBlind", selfroll: "CHAT.RollSelf" } }
  ],
  summary: a => fromUuidSync(a.doc)?.name ?? "—",
  async run(action) {
    const table = await fromUuid(action.doc);
    if (table) await table.draw({ rollMode: action.rollMode });
  }
});

registerAction("macro", {
  label: "DXTT.Action.macro", icon: "fa-solid fa-code", group: "game",
  fields: [
    { key: "doc", type: "doc", label: "DXTT.Field.Macro", docTypes: ["Macro"] },
    { key: "args", type: "text", label: "DXTT.Field.MacroArgs", default: "", placeholder: "DXTT.Placeholder.MacroArgs" }
  ],
  summary: a => fromUuidSync(a.doc)?.name ?? "—",
  async run(action, ctx) {
    const macro = await fromUuid(action.doc);
    if (!macro) return;
    let args = action.args;
    try { if (args) args = JSON.parse(args); } catch { /* plain text */ }
    await macro.execute({
      token: ctx.token?.object ?? null, tokenDocument: ctx.token, actor: ctx.actor,
      tile: ctx.tile, trigger: ctx.trigger, triggerUser: ctx.user, event: ctx.event, args
    });
  }
});

/* ---- Flow ---- */

registerAction("wait", {
  label: "DXTT.Action.wait", icon: "fa-solid fa-stopwatch", group: "flow",
  fields: [{ key: "seconds", type: "number", label: "DXTT.Field.Seconds", default: 1, min: 0, max: 600, step: 0.1 }],
  summary: a => `${a.seconds}s`,
  async run(action) {
    await sleep((Number(action.seconds) || 0) * 1000);
  }
});

registerAction("toggleTrigger", {
  label: "DXTT.Action.toggleTrigger", icon: "fa-solid fa-toggle-on", group: "flow",
  fields: [
    { key: "tile", type: "doc", label: "DXTT.Field.TileThisDefault", docTypes: ["Tile"] },
    { key: "name", type: "text", label: "DXTT.Field.TriggerName", default: "", placeholder: "DXTT.Placeholder.TriggerName" },
    { key: "mode", type: "select", label: "DXTT.Field.Mode", default: "disable",
      options: { enable: "DXTT.Option.Enable", disable: "DXTT.Option.Disable", toggle: "DXTT.Option.Toggle", reset: "DXTT.Option.ResetFired" } }
  ],
  summary: a => `${L({ enable: "DXTT.Option.Enable", disable: "DXTT.Option.Disable", toggle: "DXTT.Option.Toggle", reset: "DXTT.Option.ResetFired" }[a.mode])}: ${a.name || L("DXTT.ThisTrigger")}`,
  async run(action, ctx) {
    const tile = action.tile ? fromUuidSync(action.tile) : ctx.tile;
    if (!tile) return;
    const list = foundry.utils.deepClone(tile.flags?.[MODULE_ID]?.triggers ?? []);
    const ref = action.name?.trim();
    const low = ref?.toLowerCase();
    const targets = !ref
      ? list.filter(t => tile === ctx.tile && t.id === ctx.trigger?.id)
      : list.filter(t => t.id === ref || (t.name ?? "").toLowerCase() === low);
    if (!targets.length) return;
    if (action.mode === "reset") {
      const upd = {};
      for (const t of targets) upd[`flags.${MODULE_ID}.state.-=${t.id}`] = null;
      await tile.update(upd);
      return;
    }
    for (const t of targets) t.enabled = action.mode === "toggle" ? t.enabled === false : action.mode === "enable";
    await tile.update({ [`flags.${MODULE_ID}.triggers`]: list });
  }
});

const ARM_MODES = { disarm: "DXTT.Option.Disarm", arm: "DXTT.Option.Arm", toggle: "DXTT.Option.Toggle" };

registerAction("armTile", {
  label: "DXTT.Action.armTile", icon: "fa-solid fa-shield-halved", group: "flow",
  fields: [
    { key: "tile", type: "doc", label: "DXTT.Field.TileThisDefault", docTypes: ["Tile"] },
    { key: "mode", type: "select", label: "DXTT.Field.Mode", default: "disarm", options: ARM_MODES },
    { key: "resetFired", type: "checkbox", label: "DXTT.Field.ResetFiredOnArm", hint: "DXTT.Field.ResetFiredOnArmHint", default: true,
      showIf: a => a.mode !== "disarm" }
  ],
  summary: a => {
    const tile = a.tile ? fromUuidSync(a.tile) : null;
    return `${L(ARM_MODES[a.mode] ?? ARM_MODES.disarm)}: ${tile ? tileName(tile) : L("DXTT.ThisTile")}`;
  },
  async run(action, ctx) {
    const tile = action.tile ? fromUuidSync(action.tile) : ctx.tile;
    if (!tile) throw new Error(L("DXTT.Notify.NoTile"));
    const disarm = action.mode === "toggle" ? !isDisarmed(tile) : action.mode !== "arm";
    await setDisarmed(tile, disarm, { resetFired: !disarm && action.resetFired !== false });
  }
});

registerAction("stopActions", {
  label: "DXTT.Action.stopActions", icon: "fa-solid fa-hand", group: "flow",
  fields: [],
  summary: () => "",
  async run(action, ctx) {
    ctx.stop = true;
  }
});

/* ---- Canvas effect area (only with Dxcufgb's Canvas Effects) ---- */

export const CANVAS_EFFECTS_ID = "dxcufgbs-canvas-effects";
const AREA_MODES = { show: "DXTT.Option.Show", hide: "DXTT.Option.Hide", toggle: "DXTT.Option.Toggle" };

/** The Canvas Effects API, when that module is active. */
function canvasEffects() {
  const mod = game.modules.get(CANVAS_EFFECTS_ID);
  return mod?.active && typeof mod.api?.areas === "function" ? mod.api : null;
}

/** The areas of a scene (Canvas Effects), never throwing. */
function effectAreas(scene) {
  try {
    const list = scene ? canvasEffects()?.areas(scene) : null;
    return Array.isArray(list) ? list.filter(a => a && typeof a.id === "string") : [];
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read the canvas effect areas`, err);
    return [];
  }
}

/** Registered from main.js at init, only when Canvas Effects is active. */
export function registerCanvasEffectsAction() {
  registerAction("canvasEffectArea", {
    label: "DXTT.Action.canvasEffectArea", icon: "fa-solid fa-cloud-sun-rain", group: "scene",
    fields: [
      { key: "area", type: "select", label: "DXTT.Field.Area", hint: "DXTT.Field.AreaHint", default: "",
        options: context => ({ "": "DXTT.Option.PickArea", ...Object.fromEntries(effectAreas(context?.scene).map(a => [a.id, a.name || a.id])) }) },
      { key: "mode", type: "select", label: "DXTT.Field.Mode", default: "toggle", options: AREA_MODES }
    ],
    summary: (a, context) => {
      const area = effectAreas(context?.scene).find(x => x.id === a.area);
      return `${L(AREA_MODES[a.mode] ?? AREA_MODES.toggle)}: ${area?.name ?? (a.area ? L("DXTT.App.Missing") : "—")}`;
    },
    async run(action, ctx) {
      const api = canvasEffects();
      if (!api || typeof api.saveArea !== "function") {
        console.warn(`${MODULE_ID} | "Canvas effect area" skipped: ${CANVAS_EFFECTS_ID} is not active`);
        return;
      }
      const id = typeof action.area === "string" ? action.area : "";
      const area = id ? effectAreas(ctx.scene).find(a => a.id === id) : null;
      if (!area) {
        console.warn(`${MODULE_ID} | "Canvas effect area" skipped: no area "${id}" on the scene "${ctx.scene?.name}"`);
        return;
      }
      const mode = Object.hasOwn(AREA_MODES, action.mode) ? action.mode : "toggle";
      const visible = mode === "toggle" ? area.visible === false : mode === "show";
      if ((area.visible !== false) === visible) return;
      try {
        await api.saveArea({ ...area, visible }, ctx.scene);
      } catch (err) {
        console.warn(`${MODULE_ID} | "Canvas effect area" could not save the area "${area.name}"`, err);
      }
    }
  });
}

export const GROUPS = {
  rolls: "DXTT.Group.Rolls",
  scene: "DXTT.Group.Scene",
  game: "DXTT.Group.Game",
  flow: "DXTT.Group.Flow",
  other: "DXTT.Group.Other"
};
