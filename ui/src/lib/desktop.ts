/**
 * Which wrapper the page is running in.
 *
 * The desktop build appends `?shell=macos`, `?shell=overlay` (or, before 4.0,
 * `plain`) to the URL it loads. A browser tab has no such parameter — and
 * nothing else can tell the two apart, because the page served is byte for
 * byte the same.
 *
 * It matters for the window's own buttons, which the application draws *over*
 * the content instead of in a title bar of their own:
 *
 * - macOS: close, minimise and full screen at the top left, so the rail keeps
 *   a row clear for them.
 * - Windows and Linux (`overlay`): minimise, maximise and close at the top
 *   right, over the page header. Their width comes from the Window Controls
 *   Overlay CSS variables (`env(titlebar-area-*)`), so the header reserves
 *   exactly what the system draws, whatever its scaling.
 *
 * A 4.0 page loaded by an older application gets `plain`, which keeps the
 * system's title bar and needs nothing reserved.
 */
const shell = new URLSearchParams(window.location.search).get('shell');

/** True inside the desktop application, in any of its wrappers. */
export const inDesktopApp = shell !== null;

/** True where the macOS window buttons float over the top-left corner. */
export const needsTitleBarRoom = shell === 'macos';

/** True where Windows or Linux draw their window buttons over the top-right corner. */
export const hasOverlayControls = shell === 'overlay';

/** True where the page header doubles as the bar that moves the window. */
export const headerIsTitleBar = needsTitleBarRoom || hasOverlayControls;
