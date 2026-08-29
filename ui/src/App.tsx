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
  const session = sessions.find(s => s.id === activeId);

  // The pending count belongs on the rail, so it is fetched once here rather
  // than by whichever screen happens to be open.
  useEffect(() => {
    let cancelled = false;
    state
      .get()
      .then(current => !cancelled && setPendingCount(current.pending.length))
      .catch(() => { /* the badge is not worth an error banner */ });
    const stop = state.subscribe(event => {
      if (event.type === 'state' || event.type === 'pending') {
        state.get().then(current => setPendingCount(current.pending.length)).catch(() => {});
      }
    });
    return () => { cancelled = true; stop(); };
  }, [setPendingCount]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {session ? (
          session.kind === 'shell' ? (
            <ShellPage key={session.id} server={session.server} />
          ) : (
            <FilesPage key={session.id} server={session.server} />
          )
        ) : view === 'servers' ? (
          <ServersPage />
        ) : (
          <Placeholder view={view} />
        )}
      </main>
    </div>
  );
}
