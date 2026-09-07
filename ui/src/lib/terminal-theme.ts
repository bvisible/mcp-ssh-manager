/**
 * The terminal follows the theme properly — light on light, dark on dark.
 *
 * Keeping it dark in a light window was a mistake: an application whose main
 * panel ignores the theme has not implemented the theme, it has implemented a
 * dark widget. The light palette is a warm off-white rather than pure white,
 * and its ANSI colours are darkened so red and green stay legible on it — the
 * defaults are tuned for a black ground and wash out entirely on a pale one.
 */
export const TERMINAL_THEME = {
  light: {
    background: '#fbfaf9',
    foreground: '#1c2027',
    cursor: '#1c2027',
    cursorAccent: '#fbfaf9',
    selectionBackground: '#d9dee6',
    black: '#1c2027', red: '#b32d2d', green: '#1f7a3d', yellow: '#8a6100',
    blue: '#1f5fa8', magenta: '#8b3a9e', cyan: '#106b74', white: '#5c636e',
    brightBlack: '#8b93a1', brightRed: '#d13b3b', brightGreen: '#2a9c50',
    brightYellow: '#a87a00', brightBlue: '#2a76c9', brightMagenta: '#a34bb8',
    brightCyan: '#158790', brightWhite: '#1c2027',
  },
  dark: {
    background: '#111418',
    foreground: '#e6e8eb',
    cursor: '#e6e8eb',
    cursorAccent: '#111418',
    selectionBackground: '#2c333d',
  },
};
