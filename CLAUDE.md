# Dxcufgb's Tile Triggers

FoundryVTT v13 module (id `dxcufgbs-tile-triggers`). Triggers bound to tiles run lists of actions; all actions run on
the active GM's client. No build step; unit tests in `tests/` run with `node --test tests/*.test.mjs` (CI's lint step).

## Layout
- `scripts/main.js` – settings, the module API, Tile Config tab, Tile HUD buttons and the Debug Recorder snapshot.
- `scripts/engine.js` – trigger conditions (`fireBlocker` / `shouldFire`), movement, combat turn and round events,
  dispatch to the active GM and the socket.
- `scripts/actions.js` – the action types and `runActions`. `scripts/editor.js` – the Tile Triggers window.
- `scripts/canvas.js` (click triggers, GM outlines), `scripts/disarm.js`, `scripts/shake.js`, `scripts/geometry.js`.
- `scripts/debug-recorder.js` – optional integration with Dxcufgb's Debug Recorder (`dxcufgbs-debug-recorder`):
  registers the snapshot and exports `crumb(key, data)`, a no-op unless the recorder is active and recording.

## Invariants
- Debug-recorder integration is optional; snapshot/breadcrumb data must never contain names, free text, image paths
  or URLs. Only counts, booleans, numbers and the module's own fixed ids (event types, action types via
  `actionTypeId`, reason codes; use `ownId` for values read from flags). Document ids only as `docId` / `docIds`.
- The "fire" socket message is not trusted: the active GM takes the sender from Foundry and re-checks the trigger.
- Update the wiki (not `README.md`) when behaviour, settings or the API change.
