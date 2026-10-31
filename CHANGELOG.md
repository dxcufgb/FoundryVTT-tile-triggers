# Changelog

## 1.2.1

- Fix: **Combat round starts** and **Initiative count** now fire in encounters that aren't linked to a scene (Foundry's default): the scene is taken from the combatants' tokens. A combat linked to a scene works as before. An unlinked combat with combatants on two scenes fires each scene's round triggers once per round. **Combat: only in combat** on these triggers counts such a combat too. Movement and turn triggers are unchanged.
- Unit tests for the round events, run by CI.

## 1.2.0

- New event **Combat round starts**: fires once at the start of every combat round (round 1 included) for a combat on the tile's scene. The GM's client finds it whichever scene the GM is viewing.
- New event **Initiative count**: fires once per round when combat passes the trigger's initiative count (default 20). On a tie it goes after the combatants on that count, like lair actions, and it also fires when nobody has exactly that count.
- Both have no triggering token. New trigger option **Only when a token is on the tile** (on by default): "Applies to", "Ignore hidden tokens" and "Detection" decide which tokens count. Chance, "Fires", "Combat", switched-off and disarmed tiles work as for the other events; the chance is rolled once per round, and stepping back and forward doesn't fire a round twice. "Once per token" fires while a token it hasn't fired for is on the tile. Players can't send these events; the GM's client finds them itself.
- New actions on these triggers start on "All tokens on this tile" instead of "The triggering token".
- New action **Push token**: push tokens 1–20 spaces away from or toward this tile's centre, toward or away from a picked token, tile or note, away from the triggering token, or in a compass direction. Tokens move along the grid and stop on the last free space before a wall (Foundry's movement collision) or another token. A push is a normal move, so it sets off other tiles' enter / leave / stop triggers, and the runaway guard still applies.
- **Play animation** can play at a **random patch in this tile** (a size in spaces, e.g. 4 × 4, grid-aligned and wholly inside the tile's area). New target **Tokens in the random patch** for later actions in the same list (saves, damage, conditions, pushes).
- New action **Screen shake** (low / medium / high or pixels, 0.1–10 seconds, for the same people as "Pan camera"). It shakes the map, not the windows, only for people viewing the tile's scene, and restores the view exactly. New client setting **Allow screen shake** (on by default), the one Tile Triggers setting players see.
- New action **Show / hide canvas effect area**, only while Dxcufgb's Canvas Effects is active: show, hide or toggle one of the scene's effect areas. A missing area or module logs a console warning and is skipped.
- A select field whose saved value is no longer offered keeps it, shown as *Missing*.
- API: `events` entries have a `round` flag. A custom action's `select` `options` function and its `summary` get a second argument, `context = { tile, scene }`. `ctx.patch` holds the last random patch.

## 1.1.0

- API: `runActions(list, ctx)` runs an action list the way the module does, so a custom action with `branches: true` can run its own *On success* / *On failure* lists.
- API: `actions` and `events` are read-only. Each read returns a frozen copy (registered actions included) instead of the module's live lists; add actions with `registerAction`.
- The placeholder hint under message fields now lists `{user}` (whoever set the trigger off).

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
