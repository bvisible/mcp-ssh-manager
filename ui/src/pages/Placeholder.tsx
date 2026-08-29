import type { ViewId } from '@/stores/workspace';

/**
 * The screens still living in the old single-file page. They work today at
 * `/legacy`; this shell replaces them one at a time rather than in one jump,
 * so the control plane is never half-broken between two commits.
 */
const NOTES: Record<Exclude<ViewId, 'servers'>, string> = {
  waiting: 'The approval queue.',
  health: 'CPU, memory, disk and uptime, probed on demand.',
  live: 'What your agents are running, as they run it.',
  activity: 'The audit trail.',
  options: 'Groups, known host keys and open tunnels.',
};

export function Placeholder({ view }: { view: ViewId }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h2 className="text-lg font-medium capitalize">{view}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {NOTES[view as Exclude<ViewId, 'servers'>]} Not moved into this shell yet — it is still on{' '}
        <a className="underline" href={`/legacy${window.location.search}`}>the previous page</a>.
      </p>
    </div>
  );
}
