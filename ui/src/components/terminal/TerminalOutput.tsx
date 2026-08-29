/**
 * Command output rendered as a terminal, not as text.
 *
 * The scrollback the engine captures is what the program actually wrote —
 * escape sequences included. Putting that in a `<pre>` shows the operator
 * `[32m✓[0m 1. the test passed` instead of a green tick, which is worse than
 * useless: it is the same information, made unreadable, in the one place whose
 * whole purpose is to let someone see what their agent is doing.
 *
 * So the same emulator the interactive shell uses renders it here too — read
 * only, no cursor, no input. What an agent runs then looks exactly like what
 * you would have seen had you typed it yourself, which is the point.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTheme } from '@/stores/theme';
import { TERMINAL_THEME } from '@/lib/terminal-theme';

export function TerminalOutput({ content, rows = 16 }: { content: string; rows?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  // What has already been written, so an update appends rather than redraws —
  // a stream that repaints from the top every time output arrives flickers and
  // loses the scroll position the operator was reading at.
  const written = useRef('');
  const resolved = useTheme(s => s.resolved);

  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      fontSize: 12,
      theme: TERMINAL_THEME[resolved],
      // Read-only: this is a record of what happened, and a cursor blinking in
      // it would invite someone to type into a command that has already run.
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      rows,
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(host.current);
    fit.fit();
    term.current = { term: instance, fit };
    written.current = '';

    const observer = new ResizeObserver(() => {
      if (host.current?.offsetParent !== null) fit.fit();
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      instance.dispose();
      term.current = null;
    };
    // The theme is applied by the effect below rather than by rebuilding, which
    // would clear everything already written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  useEffect(() => {
    if (term.current) term.current.term.options.theme = TERMINAL_THEME[resolved];
  }, [resolved]);

  useEffect(() => {
    const instance = term.current?.term;
    if (!instance) return;
    if (content.startsWith(written.current)) {
      // The normal case: more output on the end.
      instance.write(content.slice(written.current.length));
    } else {
      // The scrollback was trimmed from the front, so what we have is no longer
      // a suffix of what we had. Redraw rather than append garbage.
      instance.reset();
      instance.write(content);
    }
    written.current = content;
  }, [content]);

  return <div ref={host} className="px-2 py-1" style={{ background: TERMINAL_THEME[resolved].background }} />;
}
