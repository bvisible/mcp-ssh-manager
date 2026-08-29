import { useEffect } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ServersPage } from '@/pages/ServersPage';
import { ShellPage } from '@/pages/ShellPage';
import { FilesPage } from '@/pages/FilesPage';
import { WaitingPage } from '@/pages/WaitingPage';
import { HealthPage } from '@/pages/HealthPage';
import { LivePage } from '@/pages/LivePage';
import { ActivityPage } from '@/pages/ActivityPage';
import { OptionsPage } from '@/pages/OptionsPage';
import { useWorkspace } from '@/stores/workspace';
import { useServersStore } from '@/stores/servers.store';
import { state, QUEUE_EVENTS } from '@/lib/api';

export function App() {
  const { view, tabs, activeTabId, setPendingCount } = useWorkspace();
  const servers = useServersStore(s => s.servers);
  const loadServers = useServersStore(s => s.load);

  // Loaded once here rather than by the Servers screen: the rail and every
  // session pane need to resolve a serverId to a name, whichever screen the
  // page happened to open on.
  useEffect(() => { void loadServers(); }, [loadServers]);

  // The pending count belongs on the rail, so it is fetched here too.
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      state
        .get()
        .then(current => !cancelled && setPendingCount(current.pending.length))
        .catch(() => { /* the badge is not worth an error banner */ });
    void refresh();
    const stop = state.subscribe(event => {
      if ((QUEUE_EVENTS as readonly string[]).includes(event.type)) void refresh();
    });
    return () => { cancelled = true; stop(); };
  }, [setPendingCount]);

  const nameFor = (serverId: string) => servers.find(s => s.id === serverId)?.name ?? serverId;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
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
            // Hidden panes are not reachable by keyboard or screen reader; the
            // active one is a normal part of the page.
            aria-hidden={activeTabId !== tab.id}
            inert={activeTabId !== tab.id}
          >
            {tab.type === 'ssh-terminal' ? (
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
            {view === 'options' && <OptionsPage />}
          </div>
        )}
      </main>
    </div>
  );
}
