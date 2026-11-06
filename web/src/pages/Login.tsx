import { useState } from 'react';
import { AlertCircle, ArrowRight, Bot, Eye, EyeOff, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button, Input } from '../components/ui';

function PasswordInput(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  label: string;
  mode?: 'new' | 'current';
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-2">
      <label htmlFor={props.id} className="field-label">
        {props.label}
      </label>
      <div className="relative">
        <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={props.id}
          type={visible ? 'text' : 'password'}
          autoComplete={props.mode === 'current' ? 'current-password' : 'new-password'}
          autoFocus={props.autoFocus}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          className="pl-9 pr-10"
        />
        <button
          type="button"
          aria-label={visible ? 'Hide password' : 'Show password'}
          onClick={() => setVisible((value) => !value)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
        <Bot className="h-6 w-6" />
      </span>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agent Manager</h1>
        <p className="text-xs text-muted-foreground">Self-hosted AI workforce control room</p>
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error}</span>
    </div>
  );
}

export function Login(props: {
  onSubmit: (password: string) => void;
  error: string;
  busy: boolean;
  setupRequired?: boolean;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  /* ---------------- first-run: create the admin password ---------------- */
  if (props.setupRequired) {
    const mismatch = confirm.length > 0 && password !== confirm;
    const tooShort = password.length > 0 && password.length < 8;
    const valid = password.length >= 8 && password === confirm && !props.busy;

    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <Brand />

          <div className="surface p-6 shadow-2xl sm:p-8">
            <div className="mb-6 space-y-1">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                <ShieldCheck className="h-3.5 w-3.5" />
                First-run setup
              </span>
              <h2 className="text-lg font-semibold">Create your admin password</h2>
              <p className="text-sm text-muted-foreground">
                Stored only as an encrypted scrypt hash — never written to a config file in plaintext.
              </p>
            </div>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (valid) props.onSubmit(password);
              }}
            >
              <PasswordInput
                id="new-password"
                label="Admin password"
                value={password}
                onChange={setPassword}
                placeholder="At least 8 characters"
                autoFocus
              />
              <PasswordInput
                id="confirm-password"
                label="Confirm password"
                value={confirm}
                onChange={setConfirm}
                placeholder="Repeat the password"
              />

              {(mismatch || tooShort) && (
                <p className="text-xs text-amber-300">
                  {mismatch ? 'Passwords do not match.' : 'Password must be at least 8 characters.'}
                </p>
              )}
              {props.error && <ErrorBox error={props.error} />}

              <Button type="submit" className="w-full" disabled={!valid}>
                {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {props.busy ? 'Creating…' : 'Create password & sign in'}
              </Button>
            </form>
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            Next, you can paste your OpenRouter key in Settings — it is stored encrypted, never in a file.
          </p>
        </div>
      </div>
    );
  }

  /* ---------------- normal login ---------------- */
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Brand />

        <div className="surface p-6 shadow-2xl sm:p-8">
          <div className="mb-6 space-y-1">
            <h2 className="text-lg font-semibold">Sign in</h2>
            <p className="text-sm text-muted-foreground">Enter the admin password.</p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (password && !props.busy) props.onSubmit(password);
            }}
          >
            <PasswordInput
              id="admin-password"
              label="Admin password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              autoFocus
              mode="current"
            />

            {props.error && <ErrorBox error={props.error} />}

            <Button
              type="submit"
              className="w-full"
              disabled={!password || props.busy}
            >
              {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {props.busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Sessions stay on this device for 7 days. The dashboard is bound to{' '}
          <code className="font-mono">127.0.0.1</code> by default.
        </p>
      </div>
    </div>
  );
}
