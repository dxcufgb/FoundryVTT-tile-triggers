/**
 * Dxcufgb's Tile Triggers (dxcufgbs-tile-triggers) - Foundry VTT V13
 *
 * Bind triggers to tiles. A trigger listens for an event (a token enters, leaves or stops on the
 * tile, a combat turn starts or ends on it, a player clicks it, or the GM fires it) and runs a list
 * of actions (reveal things, ask for a saving throw with success / failure branches, damage, pause
 * the game, whisper the GM, teleport, open doors, play a sound, run a macro, ...).
 *
 * API: game.modules.get("dxcufgbs-tile-triggers").api
 *   .open(tile?)                         open the Tile Triggers window (on a tile)
 *   .fire(tile, trigger, {token, force}) fire a trigger (by id or name)
 *   .getTriggers(tile) / .setTriggers(tile, triggers)
 *   .resetState(tile, triggerId?)        forget what a trigger has fired for
 *   .isDisarmed(tile)                    is the tile disarmed?
 *   .setDisarmed(tile, value, {resetFired})  disarm (true) or re-arm (false) a tile; with
 *                                        resetFired, re-arming also re-arms its "once" triggers
 *   .registerAction(type, def)           add an action type (see scripts/actions.js)
 *
 * A disarmed tile fires nothing automatically (like an inactive one) but GM-forced manual fires still
 * run. Hooks: "dxcufgbs-tile-triggers.fire" (ctx) when a trigger runs, and
 * "dxcufgbs-tile-triggers.disarm" (tile, disarmed) whenever a tile is disarmed or re-armed.
 */

import { MODULE_ID, QUERY_ROLL, EVENTS } from "./constants.js";
import { registerEngine, getTriggers, fire, resetState } from "./engine.js";
import { ACTIONS, registerAction, promptRoll, tileName } from "./actions.js";
import { TileTriggersEditor } from "./editor.js";
import { registerCanvas, drawIndicators } from "./canvas.js";
import { registerDisarm, isDisarmed, setDisarmed } from "./disarm.js";

const L = key => game.i18n.localize(key);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/* -------------------------------------------- */
/*  Init                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "DXTT.Settings.Enabled.Name", hint: "DXTT.Settings.Enabled.Hint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => drawIndicators()
  });
  game.settings.register(MODULE_ID, "promptTimeout", {
    name: "DXTT.Settings.Timeout.Name", hint: "DXTT.Settings.Timeout.Hint",
    scope: "world", config: true, type: Number, default: 60,
    range: { min: 10, max: 300, step: 5 }
  });
  game.settings.register(MODULE_ID, "showIndicators", {
    name: "DXTT.Settings.Indicators.Name", hint: "DXTT.Settings.Indicators.Hint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => { drawIndicators(); ui.controls?.render(); }
  });

  // The roll prompt a GM sends to the player who owns the token
  CONFIG.queries[QUERY_ROLL] = async ({ actorUuid, spec }) => {
    const actor = await fromUuid(actorUuid);
    if (!actor?.isOwner) return null;
    return promptRoll(actor, spec);
  };

  registerEngine();
  registerCanvas();
  registerDisarm();

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: tile => TileTriggersEditor.open(tile),
      fire,
      getTriggers,
      setTriggers: (tile, triggers) => (tile?.document ?? tile).update({ [`flags.${MODULE_ID}.triggers`]: triggers }),
      resetState,
      isDisarmed,
      setDisarmed,
      registerAction,
      actions: ACTIONS,
      events: EVENTS
    };
  }
});

/* -------------------------------------------- */
/*  Left menu (Tiles controls)                  */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", controls => {
  const tiles = controls.tiles;
  if (!tiles?.tools || !game.user.isGM) return;
  const order = Math.max(0, ...Object.values(tiles.tools).map(t => t.order ?? 0));
  tiles.tools["dxtt-editor"] = {
    name: "dxtt-editor",
    order: order + 1,
    title: "DXTT.Control.Editor",
    icon: "fa-solid fa-bolt",
    button: true,
    visible: true,
    onChange: () => TileTriggersEditor.open()
  };
  tiles.tools["dxtt-indicators"] = {
    name: "dxtt-indicators",
    order: order + 2,
    title: "DXTT.Control.Indicators",
    icon: "fa-solid fa-vector-square",
    toggle: true,
    visible: true,
    active: game.settings.get(MODULE_ID, "showIndicators"),
    onChange: (event, active) => game.settings.set(MODULE_ID, "showIndicators", active)
  };
});

/* -------------------------------------------- */
/*  Tile configuration: Triggers tab            */
/* -------------------------------------------- */

Hooks.on("renderTileConfig", (app, element) => {
  if (!game.user.isGM) return;
  const root = element instanceof HTMLElement ? element : element[0];
  const nav = root.querySelector('[data-group="sheet"][data-tab]')?.closest("nav");
  if (!nav) return;

  // Tab link (cloned from an existing one so it matches the core markup)
  if (!nav.querySelector('[data-tab="dxtt"]')) {
    const model = nav.querySelector("[data-tab]");
    const link = model ? model.cloneNode(true) : document.createElement("a");
    link.dataset.tab = "dxtt";
    link.dataset.group = "sheet";
    link.dataset.action = "tab";
    link.classList.remove("active");
    link.innerHTML = `<i class="fa-solid fa-bolt"></i> <span>${esc(L("DXTT.Tab.Label"))}</span>`;
    link.removeAttribute("aria-selected");
    nav.append(link);
  }

  // Tab content
  root.querySelector('.tab[data-tab="dxtt"]')?.remove();
  const tile = app.document;
  const panel = document.createElement("div");
  panel.className = "tab dxtt-tab";
  panel.dataset.tab = "dxtt";
  panel.dataset.group = "sheet";
  if (!tile?.id) {
    panel.innerHTML = `<p class="hint">${esc(L("DXTT.Tab.SaveFirst"))}</p>`;
  } else {
    const triggers = getTriggers(tile);
    const rows = triggers.map(t => `<li class="${t.enabled ? "" : "off"}">
        <i class="${EVENTS[t.event]?.icon ?? "fa-solid fa-bolt"}"></i>
        <strong>${esc(t.name || L(`DXTT.Event.${t.event}`))}</strong>
        <span>${esc(L(`DXTT.Event.${t.event}`))} · ${game.i18n.format("DXTT.Tab.ActionCount", { n: t.actions?.length ?? 0 })}</span>
      </li>`).join("");
    panel.innerHTML = `
      <p class="hint">${esc(L("DXTT.Tab.Hint"))}</p>
      ${triggers.length ? `<ul class="dxtt-tab-list">${rows}</ul>` : `<p class="dxtt-empty">${esc(L("DXTT.App.NoTriggers"))}</p>`}
      <button type="button" class="dxtt-open-editor"><i class="fa-solid fa-bolt"></i> ${esc(L("DXTT.Tab.Open"))}</button>`;
    panel.querySelector(".dxtt-open-editor").addEventListener("click", () => TileTriggersEditor.open(tile));
  }
  const footer = root.querySelector("footer.form-footer, .form-footer");
  if (footer) footer.before(panel); else root.append(panel);

  // Keep the tab selected across re-renders
  if (app.tabGroups?.sheet === "dxtt") {
    for (const el of root.querySelectorAll('[data-group="sheet"]')) el.classList.toggle("active", el.dataset.tab === "dxtt");
  }
});

/* -------------------------------------------- */
/*  Tile HUD button                             */
/* -------------------------------------------- */

Hooks.on("renderTileHUD", (hud, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if (!col || col.querySelector(".dxtt-hud")) return;
  const tile = hud.object?.document;
  const count = getTriggers(tile).length;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `control-icon dxtt-hud ${count ? "active" : ""}`;
  btn.dataset.tooltip = L("DXTT.Control.Editor");
  btn.innerHTML = `<i class="fa-solid fa-bolt"></i>`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    TileTriggersEditor.open(tile);
  });
  col.append(btn);

  // Disarm / re-arm (only on tiles that have triggers). The HUD re-renders itself when the flag changes.
  if (!count) return;
  const disarmed = isDisarmed(tile);
  const arm = document.createElement("button");
  arm.type = "button";
  arm.className = `control-icon dxtt-hud-arm ${disarmed ? "active" : ""}`;
  arm.dataset.tooltip = L(disarmed ? "DXTT.HUD.Rearm" : "DXTT.HUD.Disarm");
  arm.setAttribute("aria-pressed", String(disarmed));
  arm.innerHTML = `<i class="fa-solid fa-shield-halved"></i>`;
  arm.addEventListener("click", ev => {
    ev.preventDefault();
    setDisarmed(tile, !isDisarmed(tile));
  });
  col.append(arm);
});

/* -------------------------------------------- */
/*  Keep the window in sync                     */
/* -------------------------------------------- */

Hooks.on("updateTile", (tile, changes, options) => TileTriggersEditor.instance?.onTileUpdated(tile, changes, options));
Hooks.on("createTile", tile => TileTriggersEditor.instance?.onTileUpdated(tile, {}, {}));
Hooks.on("deleteTile", tile => TileTriggersEditor.instance?.onTileUpdated(tile, {}, {}));
Hooks.on("canvasReady", () => TileTriggersEditor.instance?.render());

// Copy a tile with its triggers? Foundry copies flags already; make the copy's triggers fresh (not "already fired").
Hooks.on("preCreateTile", (tile, data) => {
  if (data.flags?.[MODULE_ID]?.state) tile.updateSource({ [`flags.${MODULE_ID}.-=state`]: null });
});

export { tileName };
