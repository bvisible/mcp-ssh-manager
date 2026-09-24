import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import '@/lib/i18n';
import { hydratePreferences } from '@/lib/preferences';
import { initializeTheme } from '@/stores/theme';
import { initializeWorkspace } from '@/stores/workspace';
import { initializeSettings, useSettingsStore } from '@/stores/settings.store';
import { useServersStore } from '@/stores/servers.store';
import { App } from './App';
import './globals.css';

// Vite's single-file bundle can evaluate store modules before an awaited
// dynamic import. Initialise them explicitly after hydration, before React
// paints, so restarting on a new port restores the same workspace.
void hydratePreferences().then(() => {
  initializeTheme();
  initializeWorkspace();
  initializeSettings();
  useServersStore.setState({ viewMode: useSettingsStore.getState().serverViewMode });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* One provider at the root: every collapsed rail item is a tooltip. */}
      <TooltipPrimitive.Provider delayDuration={300}>
        <App />
      </TooltipPrimitive.Provider>
    </StrictMode>
  );
});
