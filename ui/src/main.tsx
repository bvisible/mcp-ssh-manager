import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import '@/lib/i18n';
import { hydratePreferences } from '@/lib/preferences';
import './globals.css';

// Before anything renders — and before `App` is even *imported*, which is why
// the import below is dynamic. The stores build their initial state while their
// module is evaluated, so a preference that arrives afterwards arrives too
// late: the rail would expand and snap shut, the theme would flash, the
// introduction would appear and then be dismissed.
//
// One request against a loopback port, so the delay is not perceptible. If it
// fails, whatever localStorage holds still applies and the screen is no worse
// than it was.
void hydratePreferences().then(async () => {
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* One provider at the root: every collapsed rail item is a tooltip. */}
      <TooltipPrimitive.Provider delayDuration={300}>
        <App />
      </TooltipPrimitive.Provider>
    </StrictMode>
  );
});
