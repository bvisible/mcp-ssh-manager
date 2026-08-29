/**
 * What is on screen.
 *
 * TransHub's workspace store carries a tab type for every kind of pane it can
 * open (dual-browser, remote-browser, code-chat…). This is the same shape with
 * one distinction that matters here: **fixed views** you always return to, and
 * **sessions** you opened against a particular server.
 *
 * Sessions are what make the sidebar worth having. Without them the app is six
 * tabs and a rail is overkill; with them you keep three servers open at once
 * and the rail is how you move between them.
 */
import { create } from 'zustand';

export type ViewId = 'servers' | 'waiting' | 'health' | 'live' | 'activity' | 'options';

export interface SessionTab {
  id: string;
  server: string;
  kind: 'shell' | 'files';
}

interface WorkspaceState {
  view: ViewId;
  sessions: SessionTab[];
  /** null when a fixed view is showing. */
  activeId: string | null;
  expanded: boolean;
  pendingCount: number;

  setView: (view: ViewId) => void;
  openSession: (server: string, kind: SessionTab['kind']) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  toggleExpanded: () => void;
  setPendingCount: (count: number) => void;
}

const STORAGE_KEY = 'ssh-manager.sidebar-expanded';

/** Reading storage can throw outright in a locked-down context. */
function readExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  view: 'servers',
  sessions: [],
  activeId: null,
  expanded: readExpanded(),
  pendingCount: 0,

  setView: view => set({ view, activeId: null }),

  openSession: (server, kind) => {
    // One session per server and kind: clicking "shell" twice on the same
    // machine should bring you back, not open a second identical pane.
    const existing = get().sessions.find(s => s.server === server && s.kind === kind);
    if (existing) return set({ activeId: existing.id });
    const session: SessionTab = { id: `${kind}:${server}:${Date.now()}`, server, kind };
    set(state => ({ sessions: [...state.sessions, session], activeId: session.id }));
  },

  activate: id => set({ activeId: id }),

  close: id =>
    set(state => {
      const sessions = state.sessions.filter(s => s.id !== id);
      // Closing the pane you are looking at has to land somewhere: the next
      // session if there is one, the server list otherwise.
      const activeId = state.activeId === id ? (sessions.at(-1)?.id ?? null) : state.activeId;
      return { sessions, activeId };
    }),

  toggleExpanded: () =>
    set(state => {
      const expanded = !state.expanded;
      try {
        localStorage.setItem(STORAGE_KEY, String(expanded));
      } catch {
        /* a preference that cannot be saved is still a preference for this session */
      }
      return { expanded };
    }),

  setPendingCount: pendingCount => set({ pendingCount }),
}));
