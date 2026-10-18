export const MODULE_ID = "dxcufgbs-tile-triggers";
export const SOCKET = `module.${MODULE_ID}`;
export const QUERY_ROLL = `${MODULE_ID}.roll`;

/** Event types a trigger can listen for. */
export const EVENTS = {
  enter: { icon: "fa-solid fa-person-walking-arrow-right", movement: true },
  exit: { icon: "fa-solid fa-person-walking-arrow-loop-left", movement: true },
  stop: { icon: "fa-solid fa-person", movement: true },
  turnStart: { icon: "fa-solid fa-hourglass-start", movement: false },
  turnEnd: { icon: "fa-solid fa-hourglass-end", movement: false },
  click: { icon: "fa-solid fa-hand-pointer", movement: false },
  manual: { icon: "fa-solid fa-bolt", movement: false }
};

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
    actions: []
  };
}

/** How far nested action lists (success / fail branches) can go. */
export const MAX_DEPTH = 4;
