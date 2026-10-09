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
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

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
  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-3 border-b border-border px-6',
        className,
      )}
    >
      <h1 className="flex shrink-0 items-baseline gap-1.5 text-sm font-medium">
        {title}
        {count !== undefined && count > 0 && (
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
        )}
      </h1>

      {hint && (
        // Dropped on a narrow window before the controls are: it is the least
        // important thing in the bar and the first that can go.
        <p className="hidden truncate text-xs text-muted-foreground lg:block">{hint}</p>
      )}

      {children}

      {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}
