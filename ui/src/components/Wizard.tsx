/**
 * The first three minutes.
 *
 * Somebody opening this for the first time sees an empty list and a rail of
 * icons, and has to work out from that what the application is for. The screens
 * explain themselves once there is something in them; before that, they explain
 * nothing.
 *
 * Three panels, because there are exactly three things worth saying: what this
 * watches, how to give it something to watch, and the one setting that changes
 * what an agent is allowed to do. It appears only when there are no servers,
 * and never again once it has been closed — an introduction that keeps
 * introducing itself is a nag.
 */
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, Eye, Plus, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/stores/workspace';
import { readPreference, writePreference } from '@/lib/preferences';

const SEEN_KEY = 'ssh-manager.wizard-seen';

/** @returns Whether the introduction has already been closed on this machine. */
export function wizardSeen(): boolean {
  return readPreference(SEEN_KEY) === 'true';
}

const STEPS = [
  {
    icon: Eye,
    title: 'You give your agents a shell',
    body: 'An MCP SSH server is the most dangerous tool you can hand an agent: '
      + 'a shell on machines that matter. This shows you what they are running, '
      + 'as they run it — output included — and keeps a record of what happened.',
    aside: 'Live and Activity, in the rail on the left.',
  },
  {
    icon: Plus,
    title: 'Give it something to watch',
    body: 'Add a server, or bring in the ones you already have. A `~/.ssh/config`, '
      + 'a FileZilla site manager, a Termius or PuTTY export, a spreadsheet — the '
      + 'format is worked out for you, and no password is ever read.',
    aside: 'Servers → Import.',
    action: 'import',
  },
  {
    icon: ShieldCheck,
    title: 'Decide before it runs',
    body: 'Set Approval on a server and the agent stops and waits for you: you see '
      + 'the machine, the user and the command in full, and you approve or refuse. '
      + 'It is off until you turn it on, per server, and only from here.',
    aside: 'Servers → a server → Approval.',
  },
];

export function Wizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const setView = useWorkspace(s => s.setView);
  const setWantsImport = useWorkspace(s => s.setWantsImport);
  const current = STEPS[step];
  const Icon = current.icon;
  const last = step === STEPS.length - 1;

  const finish = () => {
    writePreference(SEEN_KEY, 'true');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="flex justify-end px-3 pt-3">
          <Button variant="ghost" size="icon" aria-label="Close" onClick={finish}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-6 pb-2 text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-6 w-6 text-primary" />
          </span>
          <h2 className="text-base font-medium">{current.title}</h2>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
            {current.body}
          </p>
          <p className="mt-3 font-mono text-[11px] text-muted-foreground/80">{current.aside}</p>
        </div>

        <div className="flex items-center gap-2 px-5 py-4">
          {/* Where you are, without numbers: three dots is faster to read than
              "2 of 3" and takes no room. */}
          <span className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-4 bg-primary' : 'w-1.5 bg-border'}`}
              />
            ))}
          </span>

          <span className="ml-auto flex gap-1.5">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>
            )}
            {/* A step that names a thing to do gets the button for it, rather
                than a command to retype. */}
            {current.action === 'import' && (
              <Button variant="outline" size="sm"
                onClick={() => { setWantsImport(true); setView('servers'); finish(); }}>
                <Download className="h-3.5 w-3.5" />
                Import mine
              </Button>
            )}
            {last ? (
              <Button size="sm" onClick={() => { setView('servers'); finish(); }}>
                <Check className="h-3.5 w-3.5" />
                Add a server
              </Button>
            ) : (
              <Button size="sm" onClick={() => setStep(step + 1)}>
                Next
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
