/**
 * The actions a trigger can run. Each action type is described once here: the fields the editor
 * shows for it and what it does when it runs. All actions run on the active GM's client.
 *
 * Other modules can add their own with game.modules.get("dxcufgbs-tile-triggers").api.registerAction(type, def).
 *
 * def = {
 *   label, icon, group,
 *   fields: [{key, type, label, default, options, docTypes, fileType, min, max, step, showIf(action)}],
 *   branches: true|false,            // has "on success" / "on failure" action lists
 *   run: async (action, ctx) => {},  // ctx = {tile, trigger, token, actor, user, event, scene, depth, vars}
 *   summary: action => string        // short text for the collapsed card
 * }
 *
 * Field types: text, textarea, number, select, checkbox, formula, file, doc (one UUID), docs (UUIDs).
 */

import { MODULE_ID, QUERY_ROLL, SOCKET, MAX_DEPTH } from "./constants.js";
import { tileContains, tokenInside } from "./geometry.js";

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

/** Replace {token}, {actor}, {player}, {tile}, {trigger}, {scene}, {total}, {dc}, {result} in a text. */
export function fmt(text, ctx, extra = {}) {
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
  return String(text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in map ? esc(map[k]) : m));
}

/** The tokens an action works on. */
export function resolveTargets(action, ctx) {
  switch (action.target) {
    case "inside":
      return ctx.scene.tokens.filter(t => tokenInside(ctx.tile, t, t, ctx.trigger?.detection));
    case "picked":
      return (action.targetTokens ?? []).map(u => fromUuidSync(u)).filter(d => d?.documentName === "Token");
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

/** Player side: show the roll prompt and roll. Registered as a user query (see main.js). */
export async function promptRoll(actor, spec) {
  const id = `dxtt-roll-${foundry.utils.randomID()}`;
  const dc = spec.showDC ? ` ${game.i18n.format("DXTT.Roll.DC", { dc: spec.dc })}` : "";
  const content = `<div class="dxtt-roll-prompt">
    ${actor.img ? `<img src="${esc(actor.img)}" alt="">` : ""}
    <div>${spec.message ? `<p class="dxtt-roll-msg">${spec.message}</p>` : ""}
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

const TARGET_FIELDS = [
  { key: "target", type: "select", label: "DXTT.Field.Target", default: "trigger",
    options: { trigger: "DXTT.Option.TargetTrigger", inside: "DXTT.Option.TargetInside", picked: "DXTT.Option.TargetPicked" } },
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
      dc: Number(action.dc), showDC: !!action.showDC, message: fmt(action.message, ctx),
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

registerAction("effect", {
  label: "DXTT.Action.effect", icon: "fa-solid fa-wand-sparkles", group: "scene",
  fields: [
    { key: "file", type: "file", label: "DXTT.Field.EffectFile", fileType: "imagevideo", default: "" },
    { key: "at", type: "select", label: "DXTT.Field.At", default: "token", options: { token: "DXTT.Option.TriggerToken", tile: "DXTT.Option.ThisTile" } },
    { key: "scale", type: "number", label: "DXTT.Field.Scale", default: 1, min: 0.1, max: 10, step: 0.1 },
    { key: "below", type: "checkbox", label: "DXTT.Field.BelowTokens", default: false }
  ],
  summary: a => (a.file || "").split("/").pop(),
  async run(action, ctx) {
    const Seq = globalThis.Sequence;
    if (!Seq || !game.modules.get("sequencer")?.active) {
      ui.notifications.warn(L("DXTT.Notify.NoSequencer"));
      return;
    }
    if (!action.file) return;
    const seq = new Seq();
    const fx = seq.effect().file(action.file);
    if (action.at === "token" && ctx.token) fx.atLocation(ctx.token).scaleToObject(Number(action.scale) || 1);
    else fx.atLocation(docCenter(ctx.tile)).size({ width: ctx.tile.width * (Number(action.scale) || 1), height: ctx.tile.height * (Number(action.scale) || 1) });
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

registerAction("stopActions", {
  label: "DXTT.Action.stopActions", icon: "fa-solid fa-hand", group: "flow",
  fields: [],
  summary: () => "",
  async run(action, ctx) {
    ctx.stop = true;
  }
});

export const GROUPS = {
  rolls: "DXTT.Group.Rolls",
  scene: "DXTT.Group.Scene",
  game: "DXTT.Group.Game",
  flow: "DXTT.Group.Flow",
  other: "DXTT.Group.Other"
};
