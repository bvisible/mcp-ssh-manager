import { useEffect } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ServersPage } from '@/pages/ServersPage';
import { ShellPage } from '@/pages/ShellPage';
import { FilesPage } from '@/pages/FilesPage';
import { Placeholder } from '@/pages/Placeholder';
import { useWorkspace } from '@/stores/workspace';
import { state } from '@/lib/api';

export function App() {
  const { view, sessions, activeId, setPendingCount } = useWorkspace();

  // The pending count belongs on the rail, so it is fetched once here rather
  // than by whichever screen happens to be open.
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      state
        .get()
        .then(current => !cancelled && setPendingCount(current.pending.length))
        .catch(() => { /* the badge is not worth an error banner */ });
    void refresh();
    const stop = state.subscribe(event => {
      if (event.type === 'state' || event.type === 'pending') void refresh();
    });
    return () => { cancelled = true; stop(); };
  }, [setPendingCount]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Sessions stay mounted and are hidden rather than unmounted. Two
            reasons, and the second is not cosmetic: switching away would lose
            the directory you had navigated to, and it would *close the shell* —
            its cleanup disposes the connection. A tab you can click away from
            and come back to is the whole point of having tabs. */}
        {sessions.map(session => (
          <div
            key={session.id}
            className="absolute inset-0 flex flex-col"
            style={{ display: activeId === session.id ? 'flex' : 'none' }}
            // Hidden panes are not reachable by keyboard or screen reader; the
            // active one is a normal part of the page.
            aria-hidden={activeId !== session.id}
            inert={activeId !== session.id}
          >
            {session.kind === 'shell' ? (
              <ShellPage server={session.server} hidden={activeId !== session.id} />
            ) : (
              <FilesPage server={session.server} />
            )}
          </div>
        ))}

        {activeId === null && (
          <div className="flex min-h-0 flex-1 flex-col">
            {view === 'servers' ? <ServersPage /> : <Placeholder view={view} />}
          </div>
        )}
      </main>
    </div>
  );
}
