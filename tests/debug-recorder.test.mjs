// Unit tests for the optional Debug Recorder integration (scripts/debug-recorder.js), run with `node --test tests/`.
// Foundry's Hooks and game.modules are stubbed; the recorder is a fake API object.
import { test } from "node:test";
import assert from "node:assert/strict";

const MODULE_ID = "dxcufgbs-tile-triggers";
const RECORDER_ID = "dxcufgbs-debug-recorder";

const onceHandlers = new Map();
globalThis.Hooks = {
  on() {},
  once(name, fn) { onceHandlers.set(name, [...(onceHandlers.get(name) ?? []), fn]); },
  callAll() {}
};
const modules = new Map();
globalThis.game = { modules };

function callOnce(name, ...args) {
  const list = onceHandlers.get(name) ?? [];
  onceHandlers.delete(name);
  for (const fn of list) fn(...args);
}

function fakeRecorder({ recording = true } = {}) {
  const rec = {
    registered: [], crumbs: [], recording,
    register(id, def) { rec.registered.push({ id, def }); },
    breadcrumb(id, key, data) { rec.crumbs.push({ id, key, data }); },
    isRecording: () => rec.recording
  };
  return rec;
}

const { registerDebugRecorder, crumb, ownId, noteError, errorState } = await import("../scripts/debug-recorder.js");

test("crumb does nothing before a recorder is registered", () => {
  assert.doesNotThrow(() => crumb("trigger.fire", { event: "enter" }));
});

let rec = null;

test("registers once, from the ready hook, and crumbs only while recording", () => {
  registerDebugRecorder(() => ({ ok: true }));
  rec = fakeRecorder({ recording: false });
  callOnce(`${RECORDER_ID}.ready`, rec);
  modules.set(RECORDER_ID, { api: rec });
  callOnce("ready");
  registerDebugRecorder(() => ({ ok: true }));
  assert.equal(rec.registered.length, 1);
  assert.equal(rec.registered[0].id, MODULE_ID);
  assert.deepEqual(rec.registered[0].def.snapshot(), { ok: true });

  let built = 0;
  crumb("trigger.fire", () => { built++; return { event: "enter" }; });
  assert.equal(rec.crumbs.length, 0);
  assert.equal(built, 0, "lazy data is not built while not recording");

  rec.recording = true;
  crumb("trigger.fire", () => ({ event: "enter" }));
  crumb("app.render", { triggers: 2 });
  assert.deepEqual(rec.crumbs, [
    { id: MODULE_ID, key: "trigger.fire", data: { event: "enter" } },
    { id: MODULE_ID, key: "app.render", data: { triggers: 2 } }
  ]);
});

test("a failing recorder or snapshot never throws into the module", t => {
  t.mock.method(console, "warn", () => {});
  rec.breadcrumb = () => { throw new Error("recorder bug"); };
  assert.doesNotThrow(() => crumb("trigger.fire", { event: "enter" }));
  assert.doesNotThrow(() => crumb("trigger.fire", () => { throw new Error("bad data"); }));
  rec.isRecording = () => { throw new Error("recorder bug"); };
  assert.doesNotThrow(() => crumb("trigger.fire", { event: "enter" }));
  registerDebugRecorder(() => { throw new Error("snapshot bug"); });
  assert.deepEqual(rec.registered[0].def.snapshot(), { snapshotError: true });
  assert.equal(rec.registered.length, 1);
});

test("ownId keeps only the module's own ids", () => {
  assert.equal(ownId("enter", { enter: {}, exit: {} }), "enter");
  assert.equal(ownId("Bob's trap", { enter: {} }), "other");
  assert.equal(ownId("once", ["always", "once"]), "once");
  assert.equal(ownId(undefined, ["always"]), "other");
  assert.equal(ownId("toString", { enter: {} }), "other");
});

test("noteError counts fixed codes", () => {
  noteError("runaway");
  noteError("runaway");
  assert.equal(errorState().counts.runaway, 2);
  assert.equal(errorState().last, "runaway");
});
