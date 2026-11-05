import { useState } from 'react';
import { ArrowRight, Check, Sparkles, Smartphone, KeyRound, Bot, X } from 'lucide-react';
import { Button } from './ui';
import type { AppStatus } from '../lib/types';

export function OnboardingWizard(props: {
  status: AppStatus;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const steps = [
    { label: 'Welcome', icon: Sparkles, desc: 'This is a local WhatsApp agent hub. It supports both the classic Baileys bot and official multi-agent mode.' },
    { label: 'WhatsApp', icon: Smartphone, desc: 'Link your WhatsApp via the WhatsApp page. Skip this if you only want to use official agent tokens.' },
    { label: 'AI Model', icon: KeyRound, desc: 'Set your OpenRouter key in Settings. Skip this if you only want to explore without AI replies.' },
    { label: 'Agents', icon: Bot, desc: 'Create hub agents with official tokens. Skip if you only want the classic auto-reply bot.' },
  ];

  return (
    <div className="mx-auto w-full max-w-xl rounded-2xl border border-border bg-card/80 backdrop-blur-xl shadow-2xl">
      <div className="flex items-center justify-between rounded-t-2xl border-b border-border bg-gradient-to-r from-primary/5 to-emerald-500/5 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-glow">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold">First-time setup wizard</p>
            <p className="text-xs text-muted-foreground">Skip any step. Nothing is locked.</p>
          </div>
        </div>
        <button type="button" onClick={props.onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" aria-label="Skip wizard">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-5">
        <div className="flex gap-1.5">
          {steps.map((s, i) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setStep(i)}
              className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? 'bg-primary' : 'bg-border'}`}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        <div className="mt-5 space-y-4">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {(() => {
                const Icon = steps[step].icon;
                return <Icon className="h-4 w-4" />;
              })()}
            </span>
            <div>
              <h3 className="text-sm font-medium">Step {step + 1}: {steps[step].label}</h3>
              <p className="text-xs text-muted-foreground">{steps[step].desc}</p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Button size="sm" variant="outline" onClick={props.onClose}>Skip all</Button>
            <Button size="sm" variant="outline" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</Button>
            <Button size="sm" onClick={() => { if (step < steps.length - 1) setStep(step + 1); else props.onClose(); }}>
              <ArrowRight className="h-3.5 w-3.5" />
              {step === steps.length - 1 ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
