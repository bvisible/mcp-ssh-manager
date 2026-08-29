import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { shells, type ShellHandle } from '@/lib/api';
import { useTheme } from '@/stores/theme';
import { TERMINAL_THEME } from '@/lib/terminal-theme';
import { CommandsDropdown } from '@/components/commands/CommandsDropdown';
import { CommandDialog } from '@/components/commands/CommandDialog';



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
  const resolved = useTheme(s => s.resolved);
  const [savingCommand, setSavingCommand] = useState(false);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; handle: ShellHandle | null } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: TERMINAL_THEME[resolved],
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
    // Deliberately not depending on the theme: rebuilding the terminal would
    // drop the connection and everything on screen. The effect below repaints
    // it instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  // Following the theme without tearing the session down.
  useEffect(() => {
    if (termRef.current) termRef.current.term.options.theme = TERMINAL_THEME[resolved];
  }, [resolved]);

  // Coming back into view: the window may have been resized while this pane was
  // hidden, and a ResizeObserver does not fire for a display:none element.
  useEffect(() => {
    if (hidden || !termRef.current) return;
    const { term, fit, handle } = termRef.current;
    fit.fit();
    handle?.resize(term.cols, term.rows);
    term.focus();
  }, [hidden]);

  /**
   * Put a saved command in front of the operator without pressing Enter for
   * them. The terminal is the one screen where they are holding the keyboard,
   * and a menu that silently executes on production is a menu somebody brushes
   * past. `cd` first when the command carries a directory.
   */
  const insert = (command: { command: string; workingDirectory?: string }) => {
    const handle = termRef.current?.handle;
    if (!handle) return;
    const line = command.workingDirectory
      ? `cd ${command.workingDirectory} && ${command.command}`
      : command.command;
    handle.write(line);
    termRef.current?.term.focus();
  };

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">{server}</h1>
        <span className="text-xs text-muted-foreground">interactive shell</span>
        <div className="ml-auto">
          <CommandsDropdown server={server} onPick={insert} onManage={() => setSavingCommand(true)} />
        </div>
      </header>

      {savingCommand && (
        <CommandDialog server={server} onClose={() => setSavingCommand(false)} />
      )}
      <div ref={hostRef} className="min-h-0 flex-1 p-2"
        style={{ background: TERMINAL_THEME[resolved].background }} />
    </>
  );
}
