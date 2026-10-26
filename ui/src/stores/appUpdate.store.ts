/**
 * The desktop application's own updates, shared by the sidebar (which shows
 * that there is one) and Options → Updates (which does something about it).
 *
 * `info` is null everywhere but the desktop application: in a browser tab
 * `/api/app-update` is a 404, and then nothing about updates is drawn at all.
 * The control plane pushes every change on the event stream, so a check that
 * finds something in the background shows up without anybody asking.
 */
import { create } from 'zustand';
import { appUpdate, state, type AppUpdate } from '@/lib/api';

interface AppUpdateState {
  info: AppUpdate | null;
  /** An action is under way: the buttons wait rather than stack requests. */
  busy: boolean;
  /** What went wrong with the last thing asked for, in words. */
  error: string | null;
  load: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  /** Resolves with the page about to lose its connection on purpose. */
  install: () => Promise<void>;
}

export const useAppUpdate = create<AppUpdateState>(set => {
  const run = async (action: () => Promise<AppUpdate | unknown>) => {
    set({ busy: true, error: null });
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'currentVersion' in result) set({ info: result as AppUpdate });
    } catch (cause) {
      set({ error: (cause as Error).message });
    } finally {
      set({ busy: false });
    }
  };
  return {
    info: null,
    busy: false,
    error: null,
    load: async () => {
      try { set({ info: await appUpdate.status() }); } catch { /* an update mark is not worth an error banner */ }
    },
    check: () => run(appUpdate.check),
    download: () => run(appUpdate.download),
    install: () => run(appUpdate.install),
  };
});

let started = false;

/** Load once and follow the event stream. Called by the App; safe to call twice. */
export function initAppUpdate(): void {
  if (started) return;
  started = true;
  void useAppUpdate.getState().load();
  state.subscribe(event => {
    if (event.type === 'connection' && event.status === 'connected') void useAppUpdate.getState().load();
    if (event.type === 'app-update') {
      const { type: _type, ...info } = event;
      useAppUpdate.setState({ info: info as unknown as AppUpdate });
    }
  });
}
