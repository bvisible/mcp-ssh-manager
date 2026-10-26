import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ServersPage } from '@/pages/ServersPage';
import { ShellPage } from '@/pages/ShellPage';
import { FilesPage } from '@/pages/FilesPage';
import { WaitingPage } from '@/pages/WaitingPage';
import { HealthPage } from '@/pages/HealthPage';
import { LivePage } from '@/pages/LivePage';
import { ActivityPage } from '@/pages/ActivityPage';
import { OptionsPage } from '@/pages/OptionsPage';
import { TerminalPage } from '@/pages/TerminalPage';
import { useWorkspace } from '@/stores/workspace';
import { useServersStore } from '@/stores/servers.store';
import { state, migration, QUEUE_EVENTS } from '@/lib/api';
import { ConnectionBanner } from '@/components/layout/ConnectionStatus';
import { ensurePermission, notifyApproval, clearApproval, clearAll } from '@/lib/notify';
import { DroppedFilesDialog } from '@/components/DroppedFilesDialog';
import { DesktopBanner } from '@/components/DesktopBanner';
import { initAppUpdate } from '@/stores/appUpdate.store';
import { Wizard, wizardSeen } from '@/components/Wizard';
import { SessionTabs } from '@/components/layout/SessionTabs';

export function App() {
  const { view, tabs, activeTabId, setPendingCount } = useWorkspace();
  const servers = useServersStore(s => s.servers);
  const loadServers = useServersStore(s => s.load);
  const loadingServers = useServersStore(s => s.loading);
  const serversError = useServersStore(s => s.error);

  // Loaded once here rather than by the Servers screen: the rail and every
  // session pane need to resolve a serverId to a name, whichever screen the
  // page happened to open on.
  useEffect(() => { void loadServers(); }, [loadServers]);

  // The desktop application's own updates; nothing happens in a browser tab,
  // where the control plane has none to report.
  useEffect(() => { initAppUpdate(); }, []);

  const setView = useWorkspace(s => s.setView);

  // The approval queue: the badge on the rail, and a desktop notification for
  // anything waiting. The notification is the point — an operator watching this
  // window did not need telling, and one who isn't would otherwise find out
  // when the request had already timed out and been denied.
  useEffect(() => {
    let cancelled = false;
    const seen = new Set<string>();

    const refresh = async () => {
      try {
        const current = await state.get();
        if (cancelled) return;
        setPendingCount(current.pending.length);

        const waiting = new Set(current.pending.map(request => request.id));
        // Gone from the queue means answered or expired; a notification for a
        // decision already made invites a second one.
        for (const id of [...seen]) {
          if (!waiting.has(id)) { clearApproval(id); seen.delete(id); }
        }
        for (const request of current.pending) {
          if (seen.has(request.id)) continue;
          seen.add(request.id);
          if (await ensurePermission()) {
            notifyApproval(request, () => setView('waiting'));
          }
        }
      } catch {
        /* the badge is not worth an error banner */
      }
    };

    void refresh();
    const stop = state.subscribe(event => {
      if ((QUEUE_EVENTS as readonly string[]).includes(event.type)
        || (event.type === 'connection' && event.status === 'connected')) void refresh();
      if (event.type === 'servers') void loadServers();
    });
    return () => { cancelled = true; stop(); clearAll(); };
  }, [setPendingCount, setView, loadServers]);

  // Files dropped on the Dock icon. The desktop shell announces them over the
  // same stream everything else arrives on; a browser tab simply never sees
  // this event.
  // The introduction, on a first run with nothing configured. Deliberately not
  // shown to somebody who already has servers: they have evidently found their
  // way around.
  const [showWizard, setShowWizard] = useState(false);
  useEffect(() => {
    if (wizardSeen() || loadingServers || serversError || servers.length > 0) return;
    let cancelled = false;
    // An existing file configuration gets a migration offer, not a first-run
    // modal claiming that nothing is configured. Wait for data, never a timer.
    void migration.state().then(result => {
      if (!cancelled && result.pending.length === 0 && !wizardSeen()) setShowWizard(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [servers.length, loadingServers, serversError]);

  const [droppedFiles, setDroppedFiles] = useState<string[] | null>(null);
  useEffect(() => state.subscribe(event => {
    if (event.type === 'dropped-files' && Array.isArray(event.paths) && event.paths.length) {
      setDroppedFiles(event.paths as string[]);
    }
  }), []);


  const nameFor = (serverId?: string) =>
    servers.find(s => s.id === serverId)?.name ?? serverId ?? '';

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* No strip across the window for the title bar any more. It cost every
          screen a band of nothing; the window buttons now sit in rows that
          exist anyway — the rail's top row on macOS, the right end of the page
          header on Windows and Linux — and the header is what you drag. The
          rail stays wide enough for the macOS buttons when collapsed, which is
          what the strip was originally guarding against. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ConnectionBanner />
        <DesktopBanner />
        <SessionTabs />
        <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Sessions stay mounted and are hidden rather than unmounted. Two
            reasons, and the second is not cosmetic: switching away would lose
            the directory you had navigated to, and it would *close the shell* —
            its cleanup disposes the connection. A tab you can click away from
            and come back to is the whole point of having tabs. */}
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="absolute inset-0 flex flex-col"
            style={{ display: activeTabId === tab.id ? 'flex' : 'none' }}
            // `inert` alone: it removes the pane from the accessibility tree and
            // takes focus out of it. Adding aria-hidden as well is what the
            // browser warns about — a terminal keeps focus in a hidden textarea,
            // and aria-hidden over a focused element hides it from assistive
            // technology while it is still the focus.
            inert={activeTabId !== tab.id}
          >
            {tab.type === 'local-terminal' ? (
              <ShellPage server={tab.title} local hidden={activeTabId !== tab.id} />
            ) : tab.type === 'ssh-terminal' ? (
              <ShellPage server={nameFor(tab.serverId)} hidden={activeTabId !== tab.id} />
            ) : (
              <FilesPage server={nameFor(tab.serverId)} />
            )}
          </div>
        ))}

        {activeTabId === null && (
          <div className="flex min-h-0 flex-1 flex-col">
            {view === 'servers' && <ServersPage />}
            {view === 'waiting' && <WaitingPage />}
            {view === 'health' && <HealthPage />}
            {view === 'live' && <LivePage />}
            {view === 'activity' && <ActivityPage />}
            {view === 'terminal' && <TerminalPage />}
            {view === 'options' && <OptionsPage />}
          </div>
        )}
        </div>
      </main>
      </div>
    {/* Not over a drop. Somebody who dropped a file on the icon asked for
        something; an unsolicited introduction is not an answer to it. The
        wizard comes back once the question is dealt with. */}
    {showWizard && !droppedFiles && <Wizard onClose={() => setShowWizard(false)} />}

    {droppedFiles && (
        <DroppedFilesDialog paths={droppedFiles} onClose={() => setDroppedFiles(null)} />
      )}
    </div>
  );
}
