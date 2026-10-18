# Changelog

## 1.1.0

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
