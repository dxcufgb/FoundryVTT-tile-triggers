export const MODULE_ID = "dxcufgbs-tile-triggers";
export const SOCKET = `module.${MODULE_ID}`;
export const QUERY_ROLL = `${MODULE_ID}.roll`;

/**
 * Event types a trigger can listen for.
 * movement: set off by a token moving. round: fires once per combat round, found by the active GM, with
 * no triggering token.
 */
export const EVENTS = {
  enter: { icon: "fa-solid fa-person-walking-arrow-right", movement: true, round: false },
  exit: { icon: "fa-solid fa-person-walking-arrow-loop-left", movement: true, round: false },
  stop: { icon: "fa-solid fa-person", movement: true, round: false },
  turnStart: { icon: "fa-solid fa-hourglass-start", movement: false, round: false },
  turnEnd: { icon: "fa-solid fa-hourglass-end", movement: false, round: false },
  roundStart: { icon: "fa-solid fa-arrows-rotate", movement: false, round: true },
  initiative: { icon: "fa-solid fa-list-ol", movement: false, round: true },
  click: { icon: "fa-solid fa-hand-pointer", movement: false, round: false },
  manual: { icon: "fa-solid fa-bolt", movement: false, round: false }
};

/** The initiative count of a new "Initiative count" trigger (the lair action count). */
export const DEFAULT_INITIATIVE = 20;

/** Default values of a new trigger. */
export function defaultTrigger() {
  return {
    id: foundry.utils.randomID(),
    name: "",
    enabled: true,
    event: "enter",
    stopMovement: true,
    appliesTo: "players",
    actors: [],
    ignoreHidden: true,
    detection: "center",
    frequency: "always",
    chance: 100,
    combat: "any",
    clickRange: 1,
    initiative: DEFAULT_INITIATIVE,
    requireToken: true,
    actions: []
  };
}

/** How far nested action lists (success / fail branches) can go. */
export const MAX_DEPTH = 4;
