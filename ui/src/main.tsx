import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import '@/lib/i18n';
import { App } from './App';
import './globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* One provider at the root: every collapsed rail item is a tooltip. */}
    <TooltipPrimitive.Provider delayDuration={300}>
      <App />
    </TooltipPrimitive.Provider>
  </StrictMode>
);
