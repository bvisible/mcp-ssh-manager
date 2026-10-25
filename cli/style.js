// Terminal styles for the Node commands of the CLI.
//
// NO_COLOR (https://no-color.org): when set and not empty, no colour. Bold and
// dim stay, being emphasis rather than colour, and the application's orange
// falls back to bold — the same rules as cli/lib/colors.sh.

const noColor = Boolean(process.env.NO_COLOR);
const colour = code => (noColor ? '' : code);

export const RED = colour('\x1b[31m');
export const GREEN = colour('\x1b[32m');
export const YELLOW = colour('\x1b[33m');
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const RESET = '\x1b[0m';
/** The application's orange, #c04500: 256-colour 166. */
export const ORANGE = noColor ? BOLD : '\x1b[38;5;166m';
