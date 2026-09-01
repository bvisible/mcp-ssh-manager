/**
 * What is on screen.
 *
 * This keeps TransHub's model rather than inventing one: a list of `tabs`, each
 * with a `type`, a `title` and the `serverId` it belongs to, plus `addTab` /
 * `activateTab` / `removeTab` / `updateTab`. `ServerCard` and the rail were
 * written against exactly that, and matching it means they need no edit — which
 * is the difference between a port and a rewrite.
 *
 * What is added: the fixed views a control plane has and a file browser does
 * not (`servers`, `waiting`, `health`, `live`, `activity`, `options`). They are
 * a separate axis from tabs, because you always return to them and never close
 * them.
 */
import { create } from 'zustand';

export type ViewId = 'servers' | 'terminal' | 'waiting' | 'health' | 'live' | 'activity' | 'options';

/** The two kinds of session a server can have open. Named as TransHub names
 *  them, so its components keep working. */
export type TabType = 'dual-browser' | 'ssh-terminal';

export interface WorkspaceTab {
  id: string;
  type: TabType;
  title: string;
  serverId: string;
  closable?: boolean;
  badge?: number;
}

interface WorkspaceState {
  view: ViewId;
  tabs: WorkspaceTab[];
  /** null when a fixed view is showing. */
  activeTabId: string | null;
  expanded: boolean;
  pendingCount: number;

  setView: (view: ViewId) => void;

  /**
   * A host somebody asked to turn into a server, from somewhere that is not the
   * Servers screen — Known hosts, today. Read and cleared by ServersPage, which
   * opens its form with these fields already filled.
   */
  serverDraft: { host: string; port?: number } | null;
  setServerDraft: (draft: { host: string; port?: number } | null) => void;
  addTab: (tab: Omit<WorkspaceTab, 'closable'> & { closable?: boolean }) => void;
  activateTab: (id: string) => void;
  removeTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<WorkspaceTab>) => void;
  toggleExpanded: () => void;
  setPendingCount: (count: number) => void;
}

const STORAGE_KEY = 'ssh-manager.sidebar-expanded';

/** Reading storage can throw outright in a locked-down context. */
function readExpanded(): boolean {
  try {
    // Collapsed until somebody opens it. The rail's icons carry labels on
    // hover and the screens are what people came for; starting 192px narrower
    // gives that space to the content instead. A choice, once made, is
    // remembered.
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return true;
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  view: 'servers',
  tabs: [],
  activeTabId: null,
  expanded: readExpanded(),
  pendingCount: 0,

  setView: view => set({ view, activeTabId: null }),

  serverDraft: null,
  setServerDraft: serverDraft => set({ serverDraft }),

  addTab: tab => {
    const existing = get().tabs.find(t => t.id === tab.id);
    if (existing) return set({ activeTabId: existing.id });
    const created: WorkspaceTab = { closable: true, ...tab };
    set(state => ({ tabs: [...state.tabs, created], activeTabId: created.id }));
  },

  activateTab: id => set({ activeTabId: id }),

  removeTab: id =>
    set(state => {
      const tabs = state.tabs.filter(t => t.id !== id);
      // Closing the pane you are looking at has to land somewhere: the next
      // session if there is one, the server list otherwise.
      const activeTabId = state.activeTabId === id ? (tabs.at(-1)?.id ?? null) : state.activeTabId;
      return { tabs, activeTabId };
    }),

  updateTab: (id, updates) =>
    set(state => ({ tabs: state.tabs.map(t => (t.id === id ? { ...t, ...updates } : t)) })),

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
