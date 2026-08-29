/**
 * The server list, behind the interface TransHub's components expect.
 *
 * Backed by the encrypted vault over HTTP rather than by an Electron store —
 * that substitution is what this whole port is made of. The selectors, the
 * search and the grouping are kept identical so `ServerGrid`, `ServerCard` and
 * `CategoryGroup` drop in without an edit.
 */
import { create } from 'zustand';
import { servers as api, type ServerConfig } from '@/lib/api';

interface ServersState {
  servers: ServerConfig[];
  loading: boolean;
  error: string | null;

  searchQuery: string;
  viewMode: 'grid' | 'list';
  editMode: boolean;
  sortBy: 'name' | 'host';
  sortDirection: 'asc' | 'desc';

  setSearchQuery: (query: string) => void;
  setViewMode: (mode: 'grid' | 'list') => void;
  setEditMode: (edit: boolean) => void;
  setSortBy: (field: 'name' | 'host') => void;
  setSortDirection: (direction: 'asc' | 'desc') => void;

  load: () => Promise<void>;
  save: (server: ServerConfig) => Promise<void>;
  remove: (name: string) => Promise<void>;

  getFilteredServers: () => ServerConfig[];
  getServersByCategory: () => Map<string, ServerConfig[]>;
}

export const useServersStore = create<ServersState>((set, get) => ({
  servers: [],
  loading: true,
  error: null,

  searchQuery: '',
  viewMode: 'grid',
  editMode: false,
  sortBy: 'name',
  sortDirection: 'asc',

  setSearchQuery: searchQuery => set({ searchQuery }),
  setViewMode: viewMode => set({ viewMode }),
  setEditMode: editMode => set({ editMode }),
  setSortBy: sortBy => set({ sortBy }),
  setSortDirection: sortDirection => set({ sortDirection }),

  load: async () => {
    try {
      set({ servers: await api.list(), loading: false, error: null });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
    }
  },

  save: async server => {
    await api.save(server);
    set({ servers: await api.list() });
  },

  remove: async name => {
    await api.remove(name);
    set({ servers: await api.list() });
  },

  getFilteredServers: () => {
    const { servers, searchQuery, sortBy, sortDirection } = get();

    let filtered = servers;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = servers.filter(
        s =>
          s.name.toLowerCase().includes(q) ||
          s.host.toLowerCase().includes(q) ||
          s.username.toLowerCase().includes(q) ||
          (s.category || '').toLowerCase().includes(q)
      );
    }

    return [...filtered].sort((a, b) => {
      const cmp = sortBy === 'host' ? a.host.localeCompare(b.host) : a.name.localeCompare(b.name);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  },

  getServersByCategory: () => {
    const map = new Map<string, ServerConfig[]>();
    for (const server of get().getFilteredServers()) {
      const category = server.category || 'Uncategorized';
      if (!map.has(category)) map.set(category, []);
      map.get(category)!.push(server);
    }
    return map;
  },
}));
