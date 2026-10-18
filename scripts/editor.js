/**
 * The Tile Triggers window: pick a tile on the current scene (left), edit its triggers and their
 * actions (right). Changes are kept in a working copy until Save.
 *
 * Opened from the Tiles tool in the left menu, the Triggers tab of a tile's configuration, the Tile
 * HUD, or the API: game.modules.get("dxcufgbs-tile-triggers").api.open(tile).
 */

import { MODULE_ID, EVENTS, MAX_DEPTH, defaultTrigger } from "./constants.js";
import { ACTIONS, GROUPS, newAction, normalizeAction, tileName } from "./actions.js";
import { getTriggers, getState, fire, resetState, triggerTiles } from "./engine.js";
import { isDisarmed, setDisarmed } from "./disarm.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const L = key => game.i18n.localize(key);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const { getProperty, setProperty, deepClone, randomID } = foundry.utils;

/** The layer each placeable document type lives on (for "Add selected"). */
const LAYERS = {
  Token: "tokens", Tile: "tiles", AmbientLight: "lighting", AmbientSound: "sounds",
  Drawing: "drawings", Wall: "walls", Note: "notes"
};
const DOC_ICONS = {
  Token: "fa-solid fa-user", Tile: "fa-solid fa-cubes", AmbientLight: "fa-regular fa-lightbulb", AmbientSound: "fa-solid fa-music",
  Drawing: "fa-solid fa-pencil", Wall: "fa-solid fa-door-closed", Note: "fa-solid fa-bookmark", Actor: "fa-solid fa-user",
  JournalEntry: "fa-solid fa-book-open", JournalEntryPage: "fa-solid fa-file-lines", RollTable: "fa-solid fa-table-list", Macro: "fa-solid fa-code"
};

/** Options shown on every trigger (same field format as actions). */
const TRIGGER_FIELDS = [
  { key: "stopMovement", type: "checkbox", label: "DXTT.Trigger.StopMovement", hint: "DXTT.Trigger.StopMovementHint", showIf: t => t.event === "enter" },
  { key: "appliesTo", type: "select", label: "DXTT.Trigger.AppliesTo",
    options: { players: "DXTT.Option.AppliesPlayers", all: "DXTT.Option.AppliesAll", npcs: "DXTT.Option.AppliesNPCs", actors: "DXTT.Option.AppliesActors" },
    showIf: t => t.event !== "manual" },
  { key: "actors", type: "docs", label: "DXTT.Trigger.Actors", docTypes: ["Actor"], showIf: t => t.appliesTo === "actors" && t.event !== "manual" },
  { key: "ignoreHidden", type: "checkbox", label: "DXTT.Trigger.IgnoreHidden", showIf: t => t.event !== "manual" },
  { key: "detection", type: "select", label: "DXTT.Trigger.Detection",
    options: { center: "DXTT.Option.DetectCenter", overlap: "DXTT.Option.DetectOverlap" },
    showIf: t => !["click", "manual"].includes(t.event) },
  { key: "frequency", type: "select", label: "DXTT.Trigger.Frequency",
    options: { always: "DXTT.Option.Always", once: "DXTT.Option.Once", oncePerToken: "DXTT.Option.OncePerToken" } },
  { key: "chance", type: "number", label: "DXTT.Trigger.Chance", min: 0, max: 100, step: 1 },
  { key: "combat", type: "select", label: "DXTT.Trigger.Combat",
    options: { any: "DXTT.Option.CombatAny", in: "DXTT.Option.CombatIn", out: "DXTT.Option.CombatOut" } },
  { key: "clickRange", type: "number", label: "DXTT.Trigger.ClickRange", hint: "DXTT.Trigger.ClickRangeHint", min: 0, step: 1, showIf: t => t.event === "click" }
];

export class TileTriggersEditor extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "dxtt-editor",
    classes: ["dxtt-editor"],
    tag: "div",
    window: { title: "DXTT.App.Title", icon: "fa-solid fa-bolt", resizable: true },
    position: { width: 980, height: 760 },
    actions: {
      selectTile: TileTriggersEditor.#onSelectTile,
      useSelected: TileTriggersEditor.#onUseSelected,
      panTile: TileTriggersEditor.#onPanTile,
      tileConfig: TileTriggersEditor.#onTileConfig,
      addTrigger: TileTriggersEditor.#onAddTrigger,
      trigger: TileTriggersEditor.#onTriggerOp,
      addAction: TileTriggersEditor.#onAddAction,
      action: TileTriggersEditor.#onActionOp,
      addSelected: TileTriggersEditor.#onAddSelected,
      removeDoc: TileTriggersEditor.#onRemoveDoc,
      showDoc: TileTriggersEditor.#onShowDoc,
      browseFile: TileTriggersEditor.#onBrowseFile,
      copy: TileTriggersEditor.#onCopy,
      paste: TileTriggersEditor.#onPaste,
      resetAll: TileTriggersEditor.#onResetAll,
      toggleDisarmed: TileTriggersEditor.#onToggleDisarmed,
      save: TileTriggersEditor.#onSave,
      revert: TileTriggersEditor.#onRevert
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/editor.hbs`, scrollable: [".dxtt-main", ".dxtt-tile-list"] }
  };

  static instance = null;

  /** Triggers copied with "Copy", for "Paste" on another tile. */
  static clipboard = null;

  /**
   * Open the window, optionally on a given tile.
   * @param {TileDocument|Tile|string} [tile]
   */
  static async open(tile = null) {
    if (!game.user.isGM) return null;
    if (typeof tile === "string") tile = await fromUuid(tile);
    tile = tile?.document ?? tile;
    if (!this.instance) this.instance = new this();
    const app = this.instance;
    if (tile && (tile.id !== app.tileId || tile.parent?.id !== app.sceneId)) {
      if (!(await app.#confirmLeave())) return app;
      app.#load(tile);
    } else if (!app.tileId) {
      const first = canvas.tiles?.controlled[0]?.document ?? triggerTiles(canvas.scene)[0];
      if (first) app.#load(first);
    }
    if (app.rendered) app.bringToFront();
    await app.render({ force: true });
    return app;
  }

  constructor(options = {}) {
    super(options);
    this.sceneId = null;
    this.tileId = null;
    this.data = null;
    this.dirty = false;
    this.collapsed = new Set();
  }

  /** The tile being edited. */
  get tile() {
    return game.scenes.get(this.sceneId)?.tiles.get(this.tileId) ?? null;
  }

  #load(tile) {
    this.sceneId = tile?.parent?.id ?? null;
    this.tileId = tile?.id ?? null;
    const f = tile?.flags?.[MODULE_ID] ?? {};
    this.data = tile ? {
      name: f.name ?? "",
      shape: f.shape ?? "rectangle",
      active: f.disabled !== true,
      triggers: getTriggers(tile).map(t => ({ ...t, actions: (t.actions ?? []).map(a => deepNormalize(a)) }))
    } : null;
    this.dirty = false;
  }

  async #confirmLeave() {
    if (!this.dirty || !this.tile) return true;
    const choice = await DialogV2.wait({
      window: { title: "DXTT.App.Unsaved" },
      content: `<p>${esc(L("DXTT.App.UnsavedText"))}</p>`,
      rejectClose: false,
      buttons: [
        { action: "save", label: "DXTT.App.Save", icon: "fa-solid fa-floppy-disk", default: true },
        { action: "discard", label: "DXTT.App.Discard", icon: "fa-solid fa-trash" },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
      ]
    });
    if (choice === "save") { await this.#save(); return true; }
    if (choice === "discard") { this.dirty = false; return true; }
    return false;
  }

  /** Called when the tile changes elsewhere (e.g. a trigger fired, or was toggled by an action). */
  onTileUpdated(tile, changes, options) {
    if (!this.rendered) return;
    const ours = tile.id === this.tileId && tile.parent?.id === this.sceneId;
    if (ours && !this.dirty && !options?.[MODULE_ID]?.state) this.#load(tile);
    this.render();
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext() {
    const scene = canvas.scene;
    const tiles = (scene?.tiles.contents ?? []).map(t => {
      const count = getTriggers(t).length;
      const src = t.texture?.src ?? "";
      return {
        id: t.id,
        name: t.flags?.[MODULE_ID]?.name || src.split("/").pop() || L("DXTT.TileUnnamed"),
        img: /\.(webm|mp4|ogv)$/i.test(src) ? null : src,
        count,
        hidden: t.hidden,
        disarmed: count > 0 && isDisarmed(t),
        active: t.id === this.tileId && scene.id === this.sceneId
      };
    }).sort((a, b) => (b.count > 0) - (a.count > 0) || a.name.localeCompare(b.name));

    const tile = this.tile;
    return {
      sceneName: scene?.name ?? "",
      tiles,
      hasTile: !!tile && !!this.data,
      otherScene: tile && tile.parent?.id !== scene?.id ? tile.parent?.name : null,
      body: tile && this.data ? this.#renderBody(tile) : "",
      dirty: this.dirty,
      canPaste: !!TileTriggersEditor.clipboard
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const el = this.element;
    el.addEventListener("change", this.#onChange.bind(this));
    el.addEventListener("input", this.#onInput.bind(this));
    el.addEventListener("dragover", ev => { if (ev.target.closest("[data-drop]")) ev.preventDefault(); });
    el.addEventListener("drop", this.#onDrop.bind(this));
  }

  #renderBody(tile) {
    const d = this.data;
    const disarmed = isDisarmed(tile);
    const state = getState(tile);
    const triggers = d.triggers.map((t, i) => this.#renderTrigger(t, i, state[t.id])).join("");
    return `
    <div class="dxtt-tile-head">
      <div class="dxtt-row">
        <label>${esc(L("DXTT.App.TileName"))}</label>
        <input type="text" data-path="name" value="${esc(d.name)}" placeholder="${esc(tile.texture?.src?.split("/").pop() ?? "")}">
        <label>${esc(L("DXTT.App.Shape"))}</label>
        <select data-path="shape" data-rerender>
          ${opts({ rectangle: "DXTT.Option.Rectangle", ellipse: "DXTT.Option.Ellipse" }, d.shape)}
        </select>
        <label class="dxtt-check"><input type="checkbox" data-path="active" ${d.active ? "checked" : ""}> ${esc(L("DXTT.App.TileActive"))}</label>
        <button type="button" class="dxtt-disarm ${disarmed ? "active" : ""}" data-action="toggleDisarmed" aria-pressed="${disarmed}"
          data-tooltip="${disarmed ? "DXTT.App.DisarmedOnHint" : "DXTT.App.DisarmedOffHint"}">
          <i class="${disarmed ? "fa-solid fa-square-check" : "fa-regular fa-square"}"></i> <i class="fa-solid fa-shield-halved"></i> ${esc(L("DXTT.App.Disarmed"))}
        </button>
      </div>
      <div class="dxtt-row dxtt-tools">
        <button type="button" data-action="panTile" data-tooltip="DXTT.App.PanTile"><i class="fa-solid fa-crosshairs"></i></button>
        <button type="button" data-action="tileConfig" data-tooltip="DXTT.App.TileConfig"><i class="fa-solid fa-gear"></i></button>
        <button type="button" data-action="copy" data-tooltip="DXTT.App.CopyHint"><i class="fa-solid fa-copy"></i> ${esc(L("DXTT.App.Copy"))}</button>
        <button type="button" data-action="paste" ${TileTriggersEditor.clipboard ? "" : "disabled"} data-tooltip="DXTT.App.PasteHint"><i class="fa-solid fa-paste"></i> ${esc(L("DXTT.App.Paste"))}</button>
        <button type="button" data-action="resetAll" data-tooltip="DXTT.App.ResetAllHint"><i class="fa-solid fa-rotate-left"></i> ${esc(L("DXTT.App.ResetAll"))}</button>
      </div>
    </div>
    <div class="dxtt-triggers">
      ${triggers || `<p class="dxtt-empty">${esc(L("DXTT.App.NoTriggers"))}</p>`}
    </div>
    <button type="button" class="dxtt-add-trigger" data-action="addTrigger"><i class="fa-solid fa-plus"></i> ${esc(L("DXTT.App.AddTrigger"))}</button>`;
  }

  #renderTrigger(t, i, st) {
    const path = `triggers.${i}`;
    const collapsed = this.collapsed.has(t.id);
    const fired = st?.count ? game.i18n.format("DXTT.App.Fired", { n: st.count }) : "";
    const events = Object.fromEntries(Object.keys(EVENTS).map(k => [k, `DXTT.Event.${k}`]));
    const fields = TRIGGER_FIELDS.filter(f => !f.showIf || f.showIf(t)).map(f => renderField(f, t[f.key], `${path}.${f.key}`)).join("");
    const btn = (op, icon, tip, extra = "") => `<button type="button" data-action="trigger" data-op="${op}" data-index="${i}" data-tooltip="${tip}" ${extra}><i class="${icon}"></i></button>`;
    return `
    <section class="dxtt-trigger ${t.enabled ? "" : "off"} ${collapsed ? "collapsed" : ""}">
      <header>
        ${btn("collapse", collapsed ? "fa-solid fa-caret-right" : "fa-solid fa-caret-down", "DXTT.App.Collapse")}
        <input type="checkbox" data-path="${path}.enabled" data-rerender ${t.enabled ? "checked" : ""} data-tooltip="DXTT.App.Enabled">
        <i class="${EVENTS[t.event]?.icon ?? "fa-solid fa-bolt"} dxtt-event-icon"></i>
        <input type="text" class="dxtt-name" data-path="${path}.name" value="${esc(t.name)}" placeholder="${esc(L(`DXTT.Event.${t.event}`))}">
        <select data-path="${path}.event" data-rerender>${opts(events, t.event)}</select>
        ${fired ? `<span class="dxtt-fired" data-tooltip="DXTT.App.FiredHint">${esc(fired)}</span>` : ""}
        <span class="dxtt-buttons">
          ${btn("fire", "fa-solid fa-play", "DXTT.App.FireNow")}
          ${btn("reset", "fa-solid fa-rotate-left", "DXTT.App.ResetFired", st?.count ? "" : "disabled")}
          ${btn("up", "fa-solid fa-arrow-up", "DXTT.App.MoveUp", i === 0 ? "disabled" : "")}
          ${btn("down", "fa-solid fa-arrow-down", "DXTT.App.MoveDown", i === this.data.triggers.length - 1 ? "disabled" : "")}
          ${btn("duplicate", "fa-solid fa-clone", "DXTT.App.Duplicate")}
          ${btn("delete", "fa-solid fa-trash", "DXTT.App.Delete")}
        </span>
      </header>
      <div class="dxtt-trigger-body">
        <p class="hint">${esc(L(`DXTT.EventHint.${t.event}`))}</p>
        <div class="dxtt-fields">${fields}</div>
        <h4><i class="fa-solid fa-list-check"></i> ${esc(L("DXTT.App.Actions"))}</h4>
        ${this.#renderActionList(t.actions, `${path}.actions`, 0)}
      </div>
    </section>`;
  }

  #renderActionList(list, path, depth) {
    const cards = (list ?? []).map((a, j) => this.#renderAction(a, `${path}.${j}`, j, list.length, depth)).join("");
    return `<div class="dxtt-actions" data-list="${path}">
      ${cards || `<p class="dxtt-empty small">${esc(L("DXTT.App.NoActions"))}</p>`}
      <div class="dxtt-add-action">
        <select class="dxtt-add-type">${actionTypeOptions()}</select>
        <button type="button" data-action="addAction" data-list="${path}"><i class="fa-solid fa-plus"></i> ${esc(L("DXTT.App.AddAction"))}</button>
      </div>
    </div>`;
  }

  #renderAction(a, path, j, n, depth) {
    const def = ACTIONS[a.type];
    const collapsed = this.collapsed.has(a.id);
    if (!def) {
      return `<div class="dxtt-action unknown"><header><i class="fa-solid fa-question"></i> ${esc(a.type)}
        <button type="button" data-action="action" data-op="delete" data-path="${path}"><i class="fa-solid fa-trash"></i></button></header></div>`;
    }
    let summary = "";
    try { summary = def.summary?.(a) ?? ""; } catch { /* ignore */ }
    const fields = def.fields.filter(f => !f.showIf || f.showIf(a)).map(f => renderField(f, a[f.key], `${path}.${f.key}`)).join("");
    const btn = (op, icon, tip, extra = "") => `<button type="button" data-action="action" data-op="${op}" data-path="${path}" data-tooltip="${tip}" ${extra}><i class="${icon}"></i></button>`;
    let branches = "";
    if (def.branches) {
      if (depth >= MAX_DEPTH) branches = `<p class="hint">${esc(L("DXTT.App.TooDeep"))}</p>`;
      else branches = `
        <div class="dxtt-branches">
          <div class="dxtt-branch success"><h5><i class="fa-solid fa-check"></i> ${esc(L("DXTT.App.OnSuccess"))}</h5>${this.#renderActionList(a.success, `${path}.success`, depth + 1)}</div>
          <div class="dxtt-branch fail"><h5><i class="fa-solid fa-xmark"></i> ${esc(L("DXTT.App.OnFail"))}</h5>${this.#renderActionList(a.fail, `${path}.fail`, depth + 1)}</div>
        </div>`;
    }
    return `
    <div class="dxtt-action ${a.disabled ? "off" : ""} ${collapsed ? "collapsed" : ""}">
      <header>
        ${btn("collapse", collapsed ? "fa-solid fa-caret-right" : "fa-solid fa-caret-down", "DXTT.App.Collapse")}
        <span class="dxtt-step">${j + 1}</span>
        <i class="${def.icon}"></i>
        <strong>${esc(L(def.label))}</strong>
        <span class="dxtt-summary">${esc(summary)}</span>
        <span class="dxtt-buttons">
          <input type="checkbox" data-path="${path}.disabled" data-invert data-rerender ${a.disabled ? "" : "checked"} data-tooltip="DXTT.App.Enabled">
          ${btn("up", "fa-solid fa-arrow-up", "DXTT.App.MoveUp", j === 0 ? "disabled" : "")}
          ${btn("down", "fa-solid fa-arrow-down", "DXTT.App.MoveDown", j === n - 1 ? "disabled" : "")}
          ${btn("duplicate", "fa-solid fa-clone", "DXTT.App.Duplicate")}
          ${btn("delete", "fa-solid fa-trash", "DXTT.App.Delete")}
        </span>
      </header>
      <div class="dxtt-action-body">
        <div class="dxtt-fields">${fields}</div>
        ${branches}
      </div>
    </div>`;
  }

  /* -------------------------------------------- */
  /*  Editing                                     */
  /* -------------------------------------------- */

  #markDirty() {
    this.dirty = true;
    this.element?.querySelector(".dxtt-footer")?.classList.add("dirty");
  }

  #valueOf(el) {
    if (el.type === "checkbox") return "invert" in el.dataset ? !el.checked : el.checked;
    if (el.type === "number" || el.dataset.number !== undefined) {
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? v : 0;
    }
    return el.value;
  }

  #onInput(ev) {
    const el = ev.target;
    if (!el.dataset?.path || el.type === "checkbox" || el.tagName === "SELECT") return;
    setProperty(this.data, el.dataset.path, this.#valueOf(el));
    this.#markDirty();
  }

  #onChange(ev) {
    const el = ev.target;
    if (!el.dataset?.path) return;
    setProperty(this.data, el.dataset.path, this.#valueOf(el));
    this.#markDirty();
    if ("rerender" in el.dataset || el.tagName === "SELECT" || el.type === "checkbox" || el.dataset.type === "formula") this.render();
  }

  async #onDrop(ev) {
    const zone = ev.target.closest("[data-drop]");
    if (!zone) return;
    ev.preventDefault();
    const TE = foundry.applications.ux.TextEditor.implementation;
    const data = TE.getDragEventData(ev);
    if (!data?.uuid) return;
    let doc = await fromUuid(data.uuid);
    const types = zone.dataset.docTypes.split(",");
    if (doc?.documentName === "Token" && types.includes("Actor") && !types.includes("Token")) doc = doc.baseActor ?? doc.actor;
    if (!doc || !types.includes(doc.documentName)) {
      ui.notifications.warn(game.i18n.format("DXTT.Notify.WrongType", { types: types.join(", ") }));
      return;
    }
    this.#addUuids(zone.dataset.drop, [doc.uuid], zone.dataset.single !== undefined);
  }

  #addUuids(path, uuids, single) {
    if (single) setProperty(this.data, path, uuids[0] ?? "");
    else {
      const list = getProperty(this.data, path) ?? [];
      for (const u of uuids) if (!list.includes(u)) list.push(u);
      setProperty(this.data, path, list);
    }
    this.#markDirty();
    this.render();
  }

  /** The array a path points into, and the index. */
  #locate(path) {
    const parts = path.split(".");
    const index = Number(parts.pop());
    return { list: getProperty(this.data, parts.join(".")), index };
  }

  /* -------------------------------------------- */
  /*  Action handlers                             */
  /* -------------------------------------------- */

  static async #onSelectTile(event, target) {
    const tile = canvas.scene?.tiles.get(target.dataset.tileId);
    if (!tile || (tile.id === this.tileId && tile.parent.id === this.sceneId)) return;
    if (!(await this.#confirmLeave())) return;
    this.#load(tile);
    this.render();
  }

  static async #onUseSelected() {
    const tile = canvas.tiles?.controlled[0]?.document;
    if (!tile) return ui.notifications.info(L("DXTT.Notify.SelectTile"));
    if (!(await this.#confirmLeave())) return;
    this.#load(tile);
    this.render();
  }

  static #onPanTile() {
    const tile = this.tile;
    if (!tile || tile.parent !== canvas.scene) return;
    canvas.animatePan({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 2, duration: 500 });
    tile.object?.control({ releaseOthers: true });
  }

  static #onTileConfig() {
    this.tile?.sheet?.render({ force: true });
  }

  static #onAddTrigger() {
    if (!this.data) return;
    this.data.triggers.push(defaultTrigger());
    this.#markDirty();
    this.render();
  }

  static async #onTriggerOp(event, target) {
    const i = Number(target.dataset.index);
    const list = this.data.triggers;
    const t = list[i];
    if (!t) return;
    switch (target.dataset.op) {
      case "collapse":
        if (this.collapsed.has(t.id)) this.collapsed.delete(t.id); else this.collapsed.add(t.id);
        return this.render();
      case "up": if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]]; break;
      case "down": if (i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]]; break;
      case "duplicate": {
        const copy = reId(deepClone(t));
        copy.name = t.name ? `${t.name} (2)` : "";
        list.splice(i + 1, 0, copy);
        break;
      }
      case "delete": {
        const ok = await DialogV2.confirm({ window: { title: "DXTT.App.Delete" }, content: `<p>${esc(L("DXTT.App.DeleteTrigger"))}</p>` });
        if (!ok) return;
        list.splice(i, 1);
        break;
      }
      case "reset":
        await resetState(this.tile, t.id);
        return;
      case "fire": {
        if (this.dirty) await this.#save();
        const token = canvas.tokens?.controlled[0]?.document ?? null;
        await fire(this.tile, t.id, { token, force: true });
        ui.notifications.info(game.i18n.format("DXTT.Notify.Fired", { trigger: t.name || L(`DXTT.Event.${t.event}`), token: token?.name ?? "—" }));
        return;
      }
    }
    this.#markDirty();
    this.render();
  }

  static #onAddAction(event, target) {
    const path = target.dataset.list;
    const type = target.closest(".dxtt-add-action")?.querySelector(".dxtt-add-type")?.value;
    if (!type || !ACTIONS[type]) return;
    const list = getProperty(this.data, path);
    if (!Array.isArray(list)) return;
    list.push(newAction(type));
    this.#markDirty();
    this.render();
  }

  static async #onActionOp(event, target) {
    const path = target.dataset.path;
    const { list, index: j } = this.#locate(path);
    const a = list?.[j];
    if (!a) return;
    switch (target.dataset.op) {
      case "collapse":
        if (this.collapsed.has(a.id)) this.collapsed.delete(a.id); else this.collapsed.add(a.id);
        return this.render();
      case "up": if (j > 0) [list[j - 1], list[j]] = [list[j], list[j - 1]]; break;
      case "down": if (j < list.length - 1) [list[j + 1], list[j]] = [list[j], list[j + 1]]; break;
      case "duplicate": list.splice(j + 1, 0, reIdAction(deepClone(a))); break;
      case "delete": list.splice(j, 1); break;
    }
    this.#markDirty();
    this.render();
  }

  static #onAddSelected(event, target) {
    const path = target.dataset.path;
    const types = target.dataset.docTypes.split(",");
    const single = target.dataset.single !== undefined;
    const uuids = [];
    for (const type of types) {
      if (type === "Actor") {
        for (const t of canvas.tokens?.controlled ?? []) {
          const actor = t.document.baseActor ?? t.actor;
          if (actor) uuids.push(actor.uuid);
        }
        continue;
      }
      const layer = canvas[LAYERS[type]];
      for (const obj of layer?.controlled ?? []) {
        if (type === "Wall" && !obj.document.door) continue;
        uuids.push(obj.document.uuid);
      }
    }
    if (!uuids.length) {
      const names = types.map(t => L(`DXTT.DocType.${t}`)).join(" / ");
      return ui.notifications.info(game.i18n.format("DXTT.Notify.SelectFirst", { types: names }));
    }
    this.#addUuids(path, single ? [uuids[0]] : uuids, single);
  }

  static #onRemoveDoc(event, target) {
    const path = target.dataset.path;
    const v = getProperty(this.data, path);
    if (Array.isArray(v)) v.splice(Number(target.dataset.index), 1);
    else setProperty(this.data, path, "");
    this.#markDirty();
    this.render();
  }

  static async #onShowDoc(event, target) {
    const doc = await fromUuid(target.dataset.uuid);
    if (!doc) return;
    if (doc.parent instanceof foundry.documents.Scene) {
      if (doc.parent !== canvas.scene) return ui.notifications.info(game.i18n.format("DXTT.Notify.OnOtherScene", { scene: doc.parent.name }));
      const obj = doc.object;
      if (obj) {
        canvas.animatePan({ x: obj.center.x, y: obj.center.y, duration: 400 });
        canvas.ping(obj.center);
      }
    } else doc.sheet?.render({ force: true });
  }

  static #onBrowseFile(event, target) {
    const path = target.dataset.path;
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type: target.dataset.fileType || "any",
      current: getProperty(this.data, path) || "",
      callback: value => {
        setProperty(this.data, path, value);
        this.#markDirty();
        this.render();
      }
    }).render({ force: true });
  }

  static #onCopy() {
    if (!this.data) return;
    TileTriggersEditor.clipboard = deepClone(this.data.triggers);
    ui.notifications.info(game.i18n.format("DXTT.Notify.Copied", { n: this.data.triggers.length }));
    this.render();
  }

  static #onPaste() {
    if (!this.data || !TileTriggersEditor.clipboard) return;
    for (const t of deepClone(TileTriggersEditor.clipboard)) this.data.triggers.push(reId(t));
    this.#markDirty();
    this.render();
  }

  static async #onResetAll() {
    if (this.tile) await resetState(this.tile);
  }

  /** Disarm / re-arm the tile. Saved at once (it isn't part of the working copy). */
  static async #onToggleDisarmed() {
    const tile = this.tile;
    if (tile) await setDisarmed(tile, !isDisarmed(tile));
  }

  static async #onSave() {
    await this.#save();
  }

  static #onRevert() {
    this.#load(this.tile);
    this.render();
  }

  async #save() {
    const tile = this.tile;
    if (!tile || !this.data) return;
    // Pick up a text field that still has focus
    const focused = this.element?.querySelector("[data-path]:focus");
    if (focused && focused.type !== "checkbox") setProperty(this.data, focused.dataset.path, this.#valueOf(focused));
    await tile.update({
      [`flags.${MODULE_ID}.triggers`]: deepClone(this.data.triggers),
      [`flags.${MODULE_ID}.name`]: this.data.name,
      [`flags.${MODULE_ID}.shape`]: this.data.shape,
      [`flags.${MODULE_ID}.disabled`]: !this.data.active
    });
    this.dirty = false;
    this.#load(tile);
    ui.notifications.info(L("DXTT.Notify.Saved"));
    this.render();
  }

  async close(options = {}) {
    if (!options.force && !(await this.#confirmLeave())) return this;
    TileTriggersEditor.instance = null;
    return super.close(options);
  }
}

/* -------------------------------------------- */
/*  Field rendering                             */
/* -------------------------------------------- */

function opts(options, current) {
  return Object.entries(options).map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(current ?? "") ? "selected" : ""}>${esc(L(label))}</option>`).join("");
}

function actionTypeOptions() {
  const groups = {};
  for (const [type, def] of Object.entries(ACTIONS)) (groups[def.group] ??= []).push([type, def]);
  return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(L(GROUPS[g] ?? g))}">${
    list.map(([type, def]) => `<option value="${type}">${esc(L(def.label))}</option>`).join("")}</optgroup>`).join("");
}

function docLabel(uuid) {
  const doc = fromUuidSync(uuid);
  if (!doc) return { name: `${L("DXTT.App.Missing")} (${uuid})`, icon: "fa-solid fa-triangle-exclamation", missing: true };
  let name = doc.name;
  if (doc.documentName === "Tile") name = tileName(doc) !== L("DXTT.TileUnnamed") ? tileName(doc) : (doc.texture?.src?.split("/").pop() ?? "Tile");
  if (doc.documentName === "Wall") name = L("DXTT.DocType.Wall");
  if (doc.documentName === "AmbientLight") name = L("DXTT.DocType.AmbientLight");
  if (doc.documentName === "AmbientSound") name = doc.path?.split("/").pop() || L("DXTT.DocType.AmbientSound");
  if (doc.documentName === "Drawing") name = doc.text || L("DXTT.DocType.Drawing");
  const scene = doc.parent instanceof foundry.documents.Scene && doc.parent !== canvas.scene ? ` [${doc.parent.name}]` : "";
  return { name: `${name ?? doc.documentName}${scene}`, icon: DOC_ICONS[doc.documentName] ?? "fa-solid fa-cube" };
}

/** One field of a trigger or action as HTML. */
function renderField(f, value, path) {
  const label = `<label>${esc(L(f.label))}${f.hint ? ` <i class="fa-solid fa-circle-question" data-tooltip="${esc(L(f.hint))}"></i>` : ""}</label>`;
  const ph = f.placeholder ? `placeholder="${esc(L(f.placeholder))}"` : "";
  switch (f.type) {
    case "checkbox":
      return `<div class="dxtt-field check"><label class="dxtt-check"><input type="checkbox" data-path="${path}" ${value ? "checked" : ""}> ${esc(L(f.label))}${f.hint ? ` <i class="fa-solid fa-circle-question" data-tooltip="${esc(L(f.hint))}"></i>` : ""}</label></div>`;
    case "select": {
      const options = typeof f.options === "function" ? f.options() : f.options;
      return `<div class="dxtt-field">${label}<select data-path="${path}">${opts(options, value)}</select></div>`;
    }
    case "number":
      return `<div class="dxtt-field">${label}<input type="number" data-path="${path}" value="${esc(value)}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} step="${f.step ?? "any"}"></div>`;
    case "textarea":
      return `<div class="dxtt-field wide">${label}<textarea data-path="${path}" rows="3" ${ph}>${esc(value)}</textarea><p class="hint">${esc(L("DXTT.App.Placeholders"))}</p></div>`;
    case "file":
      return `<div class="dxtt-field wide">${label}<div class="dxtt-file"><input type="text" data-path="${path}" data-rerender value="${esc(value)}" ${ph}>
        <button type="button" data-action="browseFile" data-path="${path}" data-file-type="${f.fileType ?? "any"}" data-tooltip="FILES.BrowseTooltip"><i class="fa-solid fa-file-import"></i></button></div></div>`;
    case "doc":
    case "docs": {
      const single = f.type === "doc";
      const list = single ? (value ? [value] : []) : (value ?? []);
      const items = list.map((u, k) => {
        const d = docLabel(u);
        return `<li class="${d.missing ? "missing" : ""}"><i class="${d.icon}"></i><span>${esc(d.name)}</span>
          <a data-action="showDoc" data-uuid="${esc(u)}" data-tooltip="DXTT.App.ShowDoc"><i class="fa-solid fa-location-crosshairs"></i></a>
          <a data-action="removeDoc" data-path="${path}" data-index="${k}" data-tooltip="DXTT.App.Remove"><i class="fa-solid fa-xmark"></i></a></li>`;
      }).join("");
      const types = f.docTypes.join(",");
      const placeable = f.docTypes.some(t => LAYERS[t] || t === "Actor");
      return `<div class="dxtt-field wide">${label}
        <div class="dxtt-docs" data-drop="${path}" data-doc-types="${types}" ${single ? "data-single" : ""}>
          <ul>${items || `<li class="dxtt-none">${esc(L(placeable ? "DXTT.App.NoDocsPick" : "DXTT.App.NoDocsDrop"))}</li>`}</ul>
          ${placeable ? `<button type="button" data-action="addSelected" data-path="${path}" data-doc-types="${types}" ${single ? "data-single" : ""}><i class="fa-solid fa-object-group"></i> ${esc(L(single ? "DXTT.App.UseSelected" : "DXTT.App.AddSelected"))}</button>` : ""}
        </div></div>`;
    }
    case "formula":
    case "text":
    default:
      return `<div class="dxtt-field ${f.type === "text" ? "wide" : ""}">${label}<input type="text" data-path="${path}" ${f.type === "formula" ? 'data-type="formula"' : ""} value="${esc(value)}" ${ph}></div>`;
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function deepNormalize(a) {
  const out = normalizeAction(a);
  if (out.success) out.success = out.success.map(deepNormalize);
  if (out.fail) out.fail = out.fail.map(deepNormalize);
  return out;
}

function reIdAction(a) {
  a.id = randomID();
  if (Array.isArray(a.success)) a.success = a.success.map(reIdAction);
  if (Array.isArray(a.fail)) a.fail = a.fail.map(reIdAction);
  return a;
}

function reId(t) {
  t.id = randomID();
  t.actions = (t.actions ?? []).map(reIdAction);
  return t;
}
