# Changelog

## 1.0.2

- Security: the GM's client no longer trusts what another client sends. Who set off a trigger is taken from Foundry, not from the message, so a player can no longer fire triggers as someone else (placeholders, "token's player(s)" recipients, a macro's `triggerUser`). Only a GM can force a trigger past its conditions. A player's events are checked again on the GM's client: the event must be the trigger's own, the token must be on the tile's scene and belong to that player (clicks: within the click range), and the trigger must be on, the tile active and not disarmed, and "Applies to", combat and "Fires" must allow it. The chance is not rolled twice. GM manual fires (▶, `api.fire`) work as before, also on disarmed and switched-off tiles.
- Security: only a GM's client can pan other users' cameras.
- Security: the saving throw / check pop-up shows its text as plain text (HTML is no longer interpreted) and only answers requests from a GM.
- `api.fire` run by a player fires only "Manual / macro only" triggers, with no token or a token of theirs, and never forced.

## 1.0.1

- Disarm and re-arm a tile. A disarmed tile fires nothing automatically, but GM manual fires still run. It is kept separate from "Triggers on this tile are active", so dealt-with traps stay recognisable.
- A shield button on the Tile HUD and a **Disarmed** toggle in the Tile Triggers window, saved immediately, plus a badge in the tile list.
- Disarmed tiles get a dashed, muted green GM outline labelled "disarmed".
- New action **Disarm / arm tile** (`armTile`: `tile`, `mode`, `resetFired`) for this tile or another one. Arming can reset the tile's "once" triggers.
- API: `isDisarmed(tile)`, `setDisarmed(tile, value, { resetFired })`. Hook: `dxcufgbs-tile-triggers.disarm` (tile, disarmed).
- The module's settings are GM-only: players no longer see a Tile Triggers section in Configure Settings.

## 1.0.0

- First release: triggers on tiles (token enters / leaves / stops on tile, combat turn start / end, click, manual).
- "Token enters tile" can stop a dragged token on the first space inside the tile.
- Actions: saving throw / ability / skill check with success and failure branches (pop-up for the player), damage / healing, conditions, show / hide things, doors, teleport (also to other scenes), change tile image, pan camera, Sequencer animation, pause / unpause, chat and whispers, sounds, journals, roll tables, macros, wait, enable / disable triggers, stop.
- Tile Triggers window (Tiles controls), Triggers tab in the tile configuration, Tile HUD button, GM-only outlines.
