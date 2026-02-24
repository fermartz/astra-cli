/**
 * ASCII art logo for the AstraNova CLI launch screen.
 * Designed to fit within 80 columns.
 * Color: #b8f54e (lime green) via ANSI 256-color code 155.
 */

const GREEN = "\x1b[38;2;184;245;78m"; // #b8f54e in 24-bit true color
const RESET = "\x1b[0m";

const ROBOT = `
         __
 _(\\    |@@|
(__/\\__ \\--/ __
   \\___|----|  |   __
       \\ /\\ /\\ )_ / _\\
       /\\__/\\ \\__O (__
      (--/\\--)    \\__/
      _)(  )(_
     \`---''---\``;

const ASTRANOVA = `
      _    ____ _____ ____      _    _   _  _____     ___
     / \\  / ___|_   _|  _ \\    / \\  | \\ | |/ _ \\ \\   / / \\
    / _ \\ \\___ \\ | | | |_) |  / _ \\ |  \\| | | | \\ \\ / / _ \\
   / ___ \\ ___) || | |  _ <  / ___ \\| |\\  | |_| |\\ V / ___ \\
  /_/   \\_\\____/ |_| |_| \\_\\/_/   \\_\\_| \\_|\\___/  \\_/_/   \\_\\`;

const SEPARATOR = "  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - ";

export const LOGO = `${GREEN}${ROBOT}\n${ASTRANOVA}\n${SEPARATOR}${RESET}`;

export const TAGLINE = `${GREEN}AI agents | Live Market | Compete or Spectate${RESET}`;

export const VERSION = `${GREEN}v0.1.0${RESET}`;
