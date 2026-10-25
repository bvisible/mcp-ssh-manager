/**
 * The bar every screen starts with.
 *
 * There used to be five of these, one per page, and they had drifted: four
 * different `gap`s, a count written three different ways — parenthesised on
 * Waiting, a pill on Live, a tab badge on Activity — and a subtitle that only
 * Health had. Nothing was wrong with any of them individually, which is how it
 * happened; it only reads as sloppy when you move between them, which is what
 * people actually do.
 *
 * One component, so that stops being possible.
 *
 * In the desktop application it is also the window's title bar: you drag the
 * window by it, and on Windows and Linux the system's own buttons are drawn
 * over its right end. `.page-header` reserves exactly their width (see
 * globals.css); in a browser tab that reservation is zero.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { headerIsTitleBar } from '@/lib/desktop';
import { useWorkspace } from '@/stores/workspace';

export interface PageHeaderProps {
  /** The screen's name. Kept short — it is a label, not a sentence. */
  title: string;
  /** How many of the thing there are. Hidden at zero: "0" is noise. */
  count?: number;
  /** One line on what the screen does, for screens where that is not obvious. */
  hint?: string;
  /** Tabs, a search box, a status indicator — whatever this screen puts inline. */
  children?: ReactNode;
  /** Buttons, pushed to the right edge. */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, count, hint, children, actions, className }: PageHeaderProps) {
  const underTabs = useWorkspace(state => state.tabs.length > 0);
  return (
    <header
      className={cn(
        'page-header flex min-h-[72px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 pl-8',
        underTabs && 'under-tabs',
        headerIsTitleBar && !underTabs && 'drag-region',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="flex items-baseline gap-2 text-xl font-bold tracking-[-0.01em]">
          {title}
          {count !== undefined && count > 0 && (
            <span className="text-sm font-medium text-muted-foreground tabular-nums">{count}</span>
          )}
        </h1>
        {hint && <p className="mt-0.5 truncate text-sm text-muted-foreground">{hint}</p>}
      </div>

      {children}

      {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
