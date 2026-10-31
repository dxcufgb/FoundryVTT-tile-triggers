# Dxcufgb's Tile Triggers

[![Foundry v13](https://img.shields.io/github/v/release/dxcufgb/FoundryVTT-tile-triggers?label=Foundry%20v13&logo=foundryvirtualtabletop&color=ff6400)](https://github.com/dxcufgb/FoundryVTT-tile-triggers/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/dxcufgb/FoundryVTT-tile-triggers/module.zip?label=downloads&color=blue)](https://github.com/dxcufgb/FoundryVTT-tile-triggers/releases)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/dxcufgb)\
[![CI](https://img.shields.io/github/actions/workflow/status/dxcufgb/FoundryVTT-tile-triggers/ci.yml?branch=main&label=CI)](https://github.com/dxcufgb/FoundryVTT-tile-triggers/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/dxcufgb/FoundryVTT-tile-triggers)](LICENSE)

<a href="https://dxcufgb.github.io/FVTT-dev-showcase/"><img src="https://dxcufgb.github.io/FVTT-dev-showcase/assets/img/workshop-badge.png" alt="Dxcufgb's Workshop: every Foundry VTT project, video and changelog in one place" width="650"></a>

Bind triggers to tiles. A pressure plate that stops the rogue in their tracks and asks for a Dexterity save, a hidden tile that reveals an ambush and pauses the game while whispering the GM, a lever that opens the portcullis, a portal that teleports the party to another scene, a lair action on initiative 20 that shoves whoever fails their save toward the lava, a ceiling that shakes the screen and drops rocks on a random patch every round. Draw a tile, add a trigger, add actions.

**Foundry VTT:** v13 · system agnostic, with dnd5e support for saves, checks, skills, damage and conditions (tested with dnd5e 5.2.5)

**Recommended:** [Sequencer](https://foundryvtt.com/packages/sequencer) for the *Play animation* action. Without it that action only shows a warning; everything else works. [Dxcufgb's Canvas Effects](https://github.com/dxcufgb/FoundryVTT-canvas-effects) for the *Show / hide canvas effect area* action, which only appears while that module is active.

## Installation

In Foundry: **Add-on Modules → Install Module**, paste this link into **Manifest URL** at the bottom, and click **Install**:

```
https://github.com/dxcufgb/FoundryVTT-tile-triggers/releases/latest/download/module.json
```

Requirements and the recommended module: see [Installation](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Installation) in the wiki.

## Documentation

The full guide is in the [wiki](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki):

- [Opening the Editor](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Opening-the-Editor): the Tile Triggers window and the GM outlines
- [Triggers](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Triggers): events (movement, combat turns and rounds, initiative counts, clicks) and trigger options; round events work in linked and unlinked encounters
- [Actions](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Actions): saves, damage, pushes, doors, teleports, screen shake, chat, sounds and more
- [Disarming a Tile](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Disarming-a-Tile): found and disarmed traps
- [Examples](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Examples): pressure plate, ambush, lever, lair action, collapsing ceiling
- [Settings](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Settings): the GM settings, and the screen shake switch every user has
- [Notes](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Notes): what players can see, movement and checks
- [API](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/API) and [Custom Actions](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Custom-Actions): for macro and module authors
- [Troubleshooting](https://github.com/dxcufgb/FoundryVTT-tile-triggers/wiki/Troubleshooting)

## License

MIT
