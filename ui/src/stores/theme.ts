/**
 * Light, dark, or whatever the system says.
 *
 * The design system carried over from TransHub defines a complete dark palette
 * — 32 tokens under `.dark` — and nothing was toggling that class, so it had
 * never once been seen. This is the switch.
 *
 * Resolved with `matchMedia` rather than by asking the desktop shell: the same
 * page runs in a browser tab, and a query that works in both is one code path
 * instead of two.
 */
import { create } from 'zustand';
import { readPreference, writePreference } from '@/lib/preferences';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'ssh-manager.theme';
const query = () => window.matchMedia('(prefers-color-scheme: dark)');

/** What `system` currently means. */
function systemPrefers(): 'light' | 'dark' {
  try {
    return query().matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readStored(): ThemeMode {
  const stored = readPreference(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * The class the stylesheet keys off. Applied to the document element rather
 * than the body so it is set before anything paints.
 */
function apply(resolved: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  // Tells the browser to draw its own scrollbars and form controls to match,
  // which is the difference between a dark page and a dark application.
  document.documentElement.style.colorScheme = resolved;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

export const useTheme = create<ThemeState>(set => {
  const mode = readStored();
  const resolved = mode === 'system' ? systemPrefers() : mode;
  apply(resolved);

  // Following the system means following it as it changes — at sunset, most
  // obviously, which is when someone would notice it had not.
  try {
    query().addEventListener('change', () => {
      set(state => {
        if (state.mode !== 'system') return state;
        const next = systemPrefers();
        apply(next);
        return { resolved: next };
      });
    });
  } catch {
    /* an environment without matchMedia keeps whatever was resolved at load */
  }

  return {
    mode,
    resolved,
    setMode: next => {
      const resolvedNext = next === 'system' ? systemPrefers() : next;
      apply(resolvedNext);
      writePreference(STORAGE_KEY, next);
      set({ mode: next, resolved: resolvedNext });
    },
  };
});
