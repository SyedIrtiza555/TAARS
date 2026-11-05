import { useState } from 'react';
import { AlertCircle, ArrowRight, Bot, Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react';
import { Button, Input } from '../components/ui';

export function Login(props: {
  onSubmit: (password: string) => void;
  error: string;
  busy: boolean;
}) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
            <Bot className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">WhatsApp Agent</h1>
            <p className="text-xs text-muted-foreground">Self-hosted AI control room</p>
          </div>
        </div>

        <div className="surface p-6 shadow-2xl sm:p-8">
          <div className="mb-6 space-y-1">
            <h2 className="text-lg font-semibold">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Enter the admin password from your <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-xs">.env</code> file.
            </p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (password && !props.busy) props.onSubmit(password);
            }}
          >
            <div className="space-y-2">
              <label htmlFor="admin-password" className="field-label">
                Admin password
              </label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="admin-password"
                  type={visible ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
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

            {props.error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{props.error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={!password || props.busy}>
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
