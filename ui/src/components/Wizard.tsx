import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, LockKeyhole, Monitor, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useWorkspace } from '@/stores/workspace';
import { readPreference, writePreference } from '@/lib/preferences';

const SEEN_KEY = 'ssh-manager.wizard-seen';
export const wizardSeen = () => readPreference(SEEN_KEY) === 'true';

const STEPS = [
  {
    eyebrow: 'A place for your servers',
    title: 'Your servers. Your workspace.',
    body: 'Open a terminal, move files and see what your agents are doing — all from one place on your machine.',
    detail: 'Already using npm or the CLI? Your setup keeps working. You can explore this interface whenever you want.',
  },
  {
    eyebrow: 'Start with what you have',
    title: 'Bring your servers along.',
    body: 'Add your first connection or import servers from an SSH config, another SSH client or a spreadsheet.',
    detail: 'You review the servers before importing. Your original files stay in place, so you can keep using your existing tools.',
  },
  {
    eyebrow: 'You decide how far agents go',
    title: 'Stay in control.',
    body: 'Choose which agent requests need your approval. See the server and the full command before you approve or refuse.',
    detail: 'Approval is off by default. Once enabled on a server, requests that need approval are refused if the control plane is unavailable.',
  },
];

/** Local, decorative artwork; no downloaded images or animation dependency. */
function WelcomeIllustration({ step }: { step: number }) {
  return (
    <svg viewBox="0 0 360 260" fill="none" aria-hidden="true" className="w-full max-w-sm welcome-illustration">
      <circle cx="180" cy="130" r="105" className="fill-primary/5" />
      <circle cx="180" cy="130" r="84" className="stroke-primary/15" strokeDasharray="3 8" />
      {step === 0 ? <>
        <rect x="43" y="48" width="250" height="167" rx="14" className="fill-card stroke-border" />
        <path d="M43 81h250" className="stroke-border" />
        {[60, 73, 86].map(x => <circle key={x} cx={x} cy="65" r="3" className="fill-primary/50" />)}
        <rect x="59" y="98" width="95" height="100" rx="8" className="fill-muted" />
        {[119, 147, 175].map(y => <g key={y}>
          <rect x="72" y={y - 8} width="16" height="13" rx="3" className="stroke-muted-foreground" />
          <path d={`M98 ${y - 4}h39m-39 8h25`} className="stroke-muted-foreground/45" strokeLinecap="round" />
        </g>)}
        <path d="m173 112 7 6-7 6m17 0h12" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M173 141h87m-87 12h65m-65 12h77" className="stroke-muted-foreground/30" strokeWidth="4" strokeLinecap="round" />
        <rect x="230" y="174" width="87" height="42" rx="10" className="fill-card stroke-primary/40" />
        <path d="m246 195 5 5 10-12" className="stroke-success" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M271 191h30m-30 8h21" className="stroke-muted-foreground/45" strokeWidth="3" strokeLinecap="round" />
      </> : step === 1 ? <>
        <rect x="39" y="82" width="111" height="129" rx="12" transform="rotate(-7 39 82)" className="fill-card stroke-border" />
        <path d="M62 111h49m-46 17h63m-60 17h53m-51 17h35" className="stroke-muted-foreground/40" strokeWidth="4" strokeLinecap="round" />
        <path d="M149 140h54m-9-9 11 9-11 9" className="stroke-primary" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="217" y="56" width="99" height="154" rx="13" className="fill-card stroke-border" />
        {[78, 116, 154].map(y => <g key={y}>
          <rect x="230" y={y} width="73" height="28" rx="6" className="fill-muted stroke-border" />
          <circle cx="245" cy={y + 14} r="3" className="fill-success" />
          <path d={`M257 ${y + 14}h31`} className="stroke-muted-foreground/40" strokeWidth="3" strokeLinecap="round" />
        </g>)}
        <circle cx="117" cy="208" r="21" className="fill-card stroke-primary/40" />
        <path d="m109 208 5 5 11-12" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </> : <>
        <rect x="40" y="62" width="248" height="140" rx="14" className="fill-card stroke-border" />
        <path d="M40 95h248" className="stroke-border" />
        <circle cx="58" cy="79" r="4" className="fill-primary" />
        <path d="M73 79h78" className="stroke-muted-foreground/45" strokeWidth="4" strokeLinecap="round" />
        <path d="m59 118 7 6-7 6m17 0h12" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M100 122h109m-150 28h149" className="stroke-muted-foreground/35" strokeWidth="4" strokeLinecap="round" />
        <rect x="58" y="166" width="59" height="20" rx="6" className="fill-muted" />
        <rect x="126" y="166" width="73" height="20" rx="6" className="fill-primary/25" />
        <path d="m268 118 40 15v34c0 27-40 48-40 48s-40-21-40-48v-34l40-15Z" className="fill-card stroke-primary" strokeWidth="2" />
        <path d="m252 165 11 11 22-26" className="stroke-primary" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </>}
    </svg>
  );
}

export function Wizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const setView = useWorkspace(s => s.setView);
  const setWantsImport = useWorkspace(s => s.setWantsImport);
  const setWantsAdd = useWorkspace(s => s.setWantsAdd);
  const current = STEPS[step];
  const last = step === STEPS.length - 1;
  const finish = () => { writePreference(SEEN_KEY, 'true'); onClose(); };

  return (
    <Dialog open onOpenChange={open => !open && finish()}>
      <DialogContent className="welcome-dialog gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onCloseAutoFocus={event => event.preventDefault()}>
        <div className="grid sm:grid-cols-[0.9fr_1.1fr]">
          <div className="flex flex-col justify-between border-b border-border bg-sidebar px-6 py-5 sm:border-r sm:border-b-0">
            <span className="flex items-center gap-2 text-sm font-medium"><Monitor className="h-4 w-4 text-primary" /> SSH Manager</span>
            <div key={step} className="mx-auto w-full max-w-[200px] sm:max-w-none"><WelcomeIllustration step={step} /></div>
            <p className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><LockKeyhole className="h-3.5 w-3.5" /> On your machine. In your hands.</p>
          </div>
          <div className="flex flex-col px-7 py-7 sm:py-10">
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">{current.eyebrow}</p>
            <div key={step} className="welcome-copy">
              <DialogTitle className="max-w-xs font-display text-3xl leading-tight font-normal">{current.title}</DialogTitle>
              <DialogDescription className="mt-4 text-sm leading-relaxed">{current.body}</DialogDescription>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{current.detail}</p>
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-2">
              {step > 0 && <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}><ArrowLeft className="h-3.5 w-3.5" /> Back</Button>}
              {step === 1 && <Button variant="outline" size="sm" onClick={() => { setView('servers'); setWantsImport(true); finish(); }}><Download className="h-3.5 w-3.5" /> Import servers</Button>}
              {last ? <Button size="sm" onClick={() => { setView('servers'); setWantsAdd(true); finish(); }}><Plus className="h-3.5 w-3.5" /> Add a server</Button>
                : <Button size="sm" onClick={() => setStep(step + 1)}>Next <ArrowRight className="h-3.5 w-3.5" /></Button>}
            </div>
            <div className="mt-auto flex items-center justify-between gap-3 pt-6">
              <span aria-label={`Step ${step + 1} of ${STEPS.length}`} className="flex items-center gap-1.5">
                {STEPS.map((_, i) => <span key={i} className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${i <= step ? 'bg-primary/15 text-foreground' : 'bg-muted text-muted-foreground'}`}>
                  {i < step ? <Check className="h-3 w-3" /> : i + 1}
                </span>)}
              </span>
              <button className="rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={finish}>I’ll explore first</button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
