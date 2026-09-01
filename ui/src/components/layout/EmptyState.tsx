/**
 * What a screen shows before anything has happened on it.
 *
 * An empty screen is the first thing most people see, so it is a poor place to
 * be inconsistent — and these had drifted the same way the headers had: some
 * centred in the remaining space, some sitting at the top, different icon
 * treatments, different widths.
 *
 * The text says what would appear here and, where it is useful, what to do to
 * make that happen. "No data" tells somebody they are stuck; "Press the button
 * when you want to know" tells them what the screen is for.
 */
import type { ComponentType, ReactNode } from 'react';

export interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  /** A button, when there is an obvious next step. */
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-7 w-7 text-primary" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
