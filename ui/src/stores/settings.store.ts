/**
 * The slice of TransHub's settings store that the copied components read.
 *
 * Only view preferences live here — how the server list is laid out, which
 * categories are folded. Anything that is really configuration (a server's
 * mode, its approval policy, its credentials) belongs to the vault and is
 * reached through the API, not through a browser-local store.
 */
import { create } from 'zustand';

interface SettingsState {
  serverViewMode: 'grid' | 'list';
  collapsedCategories: string[];
  updateSetting: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  /** Fold or unfold one category in the server list. */
  toggleCategoryCollapse: (category: string) => void;
}

const STORAGE_KEY = 'ssh-manager.view-settings';

function read(): Partial<SettingsState> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    // A locked-down context can throw on access, not merely return null.
    return {};
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  serverViewMode: 'grid',
  collapsedCategories: [],
  ...read(),

  toggleCategoryCollapse: category => {
    const { collapsedCategories } = get();
    const next = collapsedCategories.includes(category)
      ? collapsedCategories.filter(c => c !== category)
      : [...collapsedCategories, category];
    get().updateSetting('collapsedCategories', next);
  },

  updateSetting: (key, value) => {
    set({ [key]: value } as Pick<SettingsState, typeof key>);
    try {
      const { serverViewMode, collapsedCategories } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ serverViewMode, collapsedCategories }));
    } catch {
      /* a preference that cannot be saved is still a preference for this session */
    }
  },
}));
