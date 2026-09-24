/**
 * Which wrapper the page is running in.
 *
 * The desktop build appends `?shell=macos` (or `plain`) to the URL it loads.
 * A browser tab has no such parameter — and nothing else can tell the two
 * apart, because the page served is byte for byte the same.
 *
 * It matters for exactly one thing: on macOS the window has no title bar and
 * the window buttons are drawn *over* the content, so the layout has to leave
 * a strip clear for them.
 */
const shell = new URLSearchParams(window.location.search).get('shell');

/** True inside the desktop application, in any of its wrappers. */
export const inDesktopApp = shell !== null;

/** True where the window buttons float over the content and need room made. */
export const needsTitleBarRoom = shell === 'macos';
