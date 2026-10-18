# Dxcufgb's Tile Triggers

[![Foundry v13](https://img.shields.io/github/v/release/dxcufgb/FoundryVTT-tile-triggers?label=Foundry%20v13&logo=foundryvirtualtabletop&color=ff6400)](https://github.com/dxcufgb/FoundryVTT-tile-triggers/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/dxcufgb/FoundryVTT-tile-triggers/module.zip?label=downloads&color=blue)](https://github.com/dxcufgb/FoundryVTT-tile-triggers/releases)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/dxcufgb)\
[![CI](https://img.shields.io/github/actions/workflow/status/dxcufgb/FoundryVTT-tile-triggers/ci.yml?branch=main&label=CI)](https://github.com/dxcufgb/FoundryVTT-tile-triggers/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/dxcufgb/FoundryVTT-tile-triggers)](LICENSE)

Bind triggers to tiles. A pressure plate that stops the rogue in their tracks and asks for a Dexterity save, a hidden tile that reveals an ambush and pauses the game while whispering the GM, a lever that opens the portcullis, a portal that teleports the party to another scene. Draw a tile, add a trigger, add actions.

**Foundry VTT:** v13 · system agnostic, with dnd5e support for saves, checks, skills, damage and conditions (tested with dnd5e 5.2.5)

## Installation

In Foundry: **Add-on Modules → Install Module**, paste this link into **Manifest URL** at the bottom, and click **Install**:

```
https://github.com/dxcufgb/FoundryVTT-tile-triggers/releases/latest/download/module.json
```

## Opening the editor

- **Tiles controls → ⚡ Tile Triggers** in the left menu. Lists every tile on the scene (tiles with triggers first). Pick one, or select a tile on the canvas and click *Use selected tile*.
- **Tile configuration → Triggers tab** shows the tile's triggers and an *Open trigger editor* button.
- **Tile HUD** (right-click a tile) has a ⚡ button.
- **Tiles controls → outline toggle** draws an orange outline and label around every tile with triggers. Only GMs ever see them, so hidden tiles make perfect traps.

Changes are kept until you click **Save**.

## Triggers

Each tile can have any number of triggers. Each trigger listens for one event:

| Event | Fires when |
| --- | --- |
| **Token enters tile** | a token reaches the tile. With **Stop movement on the tile** (on by default), a token that was dragged further stops on the first space inside the tile, whatever the drag. |
| Token leaves tile | a token leaves the tile |
| Token ends its move on tile | a token comes to rest on the tile |
| Combat turn starts / ends on tile | a combatant's turn starts or ends while its token stands on the tile |
| Player clicks tile | someone clicks the tile on the Tokens layer with one of their tokens within *Click range* (levers, chests, doors) |
| Manual / macro only | the ▶ button in the editor, or a macro |

Options on every trigger:

- **Applies to:** player characters only (default), all tokens, non-player tokens only, or specific actors.
- **Ignore hidden tokens:** GM-hidden tokens don't set it off.
- **Detection:** the token's centre must be on the tile, or any part of it.
- **Fires:** every time, once, or once per token. *Reset fired* re-arms it.
- **Chance %:** only fires sometimes.
- **Combat:** in and out of combat, only in combat, or only out of combat.

The tile itself can be a **rectangle or an ellipse**, rotated or not, and hidden or visible. Hidden tiles still trigger.

## Actions

Actions run in order on the GM's client (a GM must be logged in).

**Rolls & effects on tokens**
- **Saving throw / check.** Saving throw, ability check, skill check or any roll formula against a DC. By default the token's player gets a **pop-up** with Disadvantage / Roll / Advantage buttons. If nobody answers in time, or no owner is online, the GM's client rolls for them. Optional extras:
  - damage on a failure, with half, none or full damage on a success
  - a condition on a failure
  - a GM summary whispered to chat
  - its own **On success** and **On failure** action lists, which can hold any actions, including more checks
- **Damage / healing.** A formula and a damage type, with healing types for healing. Roll once for everyone or separately per token.
- **Condition.** Add, remove or toggle a status effect.

**Scene**
- **Show / hide things:** tokens, tiles, lights, sounds and drawings. Select them on the canvas and click *Add selected*.
- **Open / close / lock doors.**
- **Teleport** to a destination tile, on this scene or another one. Players' views are pulled along.
- **Change tile image** (an opened trapdoor, a pulled lever).
- **Pan camera** for the token's player(s), all players or everyone.
- **Play animation** with Sequencer, e.g. JB2A files at the token or the tile.

**Game, chat & media**
- **Pause / unpause the game.**
- **Chat message.** Whisper to the GM, whisper to the token's player(s), or post publicly, as the narrator or the token.
- **Play sound** for everyone, the players, the token's player(s) or only the GM.
- **Show journal** entry or page.
- **Draw from roll table.**
- **Run macro.** It gets `token`, `tokenDocument`, `actor`, `tile`, `trigger`, `triggerUser`, `event` and `args`.

**Flow**
- **Wait** a number of seconds.
- **Enable / disable a trigger**, on this or another tile, or reset what it has fired for.
- **Stop:** skip the remaining actions.

Messages can use `{token}` `{actor}` `{player}` `{tile}` `{trigger}` `{scene}`. After a roll, `{total}` `{dc}` and `{result}` are also available.

Actions on tokens can target **the triggering token**, **all tokens on this tile**, or **picked tokens**.

## Examples

**Pressure plate.** Token enters tile (stop movement, once) → Saving throw: DEX DC 14, damage on failure `2d10` piercing, half on success. On failure → Condition: prone.

**Ambush.** Hidden tile, Token enters tile (players only, once) → Show / hide things: show the four hidden goblins → Pause the game → Chat message: whisper to the GM "{token} sprang the ambush".

**Lever.** Player clicks tile (range 1) → Open / close / lock doors: toggle → Change tile image: the pulled-lever image → Play sound.

## Macro API

```js
const tt = game.modules.get("dxcufgbs-tile-triggers").api;
tt.open(tile);                                   // open the editor on a tile
await tt.fire(tile, "Spike trap", { token });    // fire a trigger by name or id
tt.getTriggers(tile);                            // read
await tt.resetState(tile);                       // re-arm "once" triggers
tt.registerAction("myAction", { label: "My action", icon: "fa-solid fa-star", fields: [...], run: async (action, ctx) => {} });
```

The hook `dxcufgbs-tile-triggers.fire` is called with the context each time a trigger runs.

## Notes

- Tile flags are visible to players' clients, so a determined player could read a trap's settings from the console.
- On gridded scenes the token stops on a grid space. On gridless scenes it stops just inside the tile's edge.
- Moves undone with Ctrl+Z, and pasted tokens, don't set off triggers.

## License

MIT
