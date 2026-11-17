/**
 * A command shown in full, with a button to copy it.
 *
 * Wrapped, not truncated: half a command is how you approve the wrong thing,
 * and it is no better for reading back what an agent ran. Shared by the
 * approval card and the live view so the two cannot drift apart.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';

type Props = {
  /** The command; when absent a placeholder is shown and there is nothing to copy. */
  command?: string | null;
  /** `default` is sized for deciding on a command, `compact` for reading one back. */
  size?: 'default' | 'compact';
  className?: string;
};

export function CommandBlock({ command, size = 'default', className }: Props) {
  const [copied, setCopied] = useState(false);
  const compact = size === 'compact';

  const copy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the command is on screen in full; a failed copy costs nothing */
    }
  };

  return (
    <div className={cn('flex items-start gap-2 bg-secondary', className)}>
      <pre
        className={cn(
          'min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono',
          compact ? 'py-1 text-xs' : 'text-[14.5px] leading-relaxed'
        )}
      >
        {command || tr("(no command)")}
      </pre>
      {command && (
        <button
          type="button"
          aria-label={copied ? tr("Copied") : tr("Copy the command")}
          title={copied ? tr("Copied") : tr("Copy the command")}
          onClick={() => void copy()}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground',
            compact ? 'h-6 w-6' : 'h-8 w-8'
          )}
        >
          {copied
            ? <Check className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            : <Copy className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
        </button>
      )}
    </div>
  );
}
