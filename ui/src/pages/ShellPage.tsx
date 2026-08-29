import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { shells, type ShellHandle } from '@/lib/api';

/**
 * A real shell. The PTY is allocated by the remote sshd — ssh2 asks for it — so
 * this side only has to draw bytes and send keystrokes.
 *
 * `hidden` rather than unmounting: the pane stays alive when you switch to
 * another session, because disposing it would close the connection and lose
 * everything on screen.
 */
export function ShellPage({ server, hidden = false }: { server: string; hidden?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; handle: ShellHandle | null } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      // Matches the design system's ground rather than xterm's default black,
      // which reads as a hole punched in the page.
      theme: { background: '#111418', foreground: '#e6e8eb' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = { term, fit, handle: null };

    let disposed = false;
    void shells
      .open(server, term.cols, term.rows)
      .then(opened => {
        // The pane can be closed while the connection is still being made.
        if (disposed) return void opened.close();
        if (termRef.current) termRef.current.handle = opened;
        opened.onData(chunk => term.write(chunk));
        opened.onExit(() => term.write('\r\n\x1b[2m— connection closed —\x1b[0m\r\n'));
        term.onData(data => opened.write(data));
      })
      .catch(error => term.write(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`));

    const observer = new ResizeObserver(() => {
      // A hidden pane measures zero, and fitting to zero corrupts the layout
      // it will be restored into.
      if (host.offsetParent === null) return;
      fit.fit();
      termRef.current?.handle?.resize(term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      void termRef.current?.handle?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [server]);

  // Coming back into view: the window may have been resized while this pane was
  // hidden, and a ResizeObserver does not fire for a display:none element.
  useEffect(() => {
    if (hidden || !termRef.current) return;
    const { term, fit, handle } = termRef.current;
    fit.fit();
    handle?.resize(term.cols, term.rows);
    term.focus();
  }, [hidden]);

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">{server}</h1>
        <span className="text-xs text-muted-foreground">interactive shell</span>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 bg-[#111418] p-2" />
    </>
  );
}
