import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RefreshCw } from 'lucide-react';
import { api } from './api';
import { Sidebar, TopBar, isPageKey } from './components/Layout';
import type { PageKey } from './components/Layout';
import { ToastStack } from './components/common';
import { AnnotationOverlay } from './components/AnnotationOverlay';
import type { Notify, ToastItem } from './components/common';
import { Button } from './components/ui';
import type { AppStatus } from './lib/types';
import { Login } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { ConversationsPage } from './pages/Conversations';
import { KnowledgePage } from './pages/Knowledge';
import { McpPage } from './pages/Mcp';
import { SettingsPage } from './pages/Settings';
import { LogsPage } from './pages/Logs';
import { TeamPage } from './pages/Team';

type AuthState = 'checking' | 'in' | 'out';

const SSE_EVENTS = [
  'hello',
  'log',
  'hub:status',
];

function pageFromHash(): PageKey {
  const value = window.location.hash.replace(/^#\/?/, '');
  return isPageKey(value) ? value : 'team';
}

function useStatus(enabled: boolean) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.get<AppStatus>('/status');
      setStatus(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Status unavailable');
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), 8000);

    let source: EventSource | null = null;
    let debounce = 0;
    try {
      source = new EventSource('/api/events');
      const schedule = () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(() => void refresh(), 350);
      };
      for (const event of SSE_EVENTS) source.addEventListener(event, schedule);
    } catch {
      /* polling still covers updates */
    }

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(debounce);
      source?.close();
    };
  }, [enabled, refresh]);

  return { status, error, refresh };
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [setupRequired, setSetupRequired] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [page, setPage] = useState<PageKey>(pageFromHash);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [wizardSkipped, setWizardSkipped] = useState(() => {
    try { return Boolean(localStorage.getItem('wizardSkipped')); } catch { return false; }
  });
  const toastId = useRef(0);

  const { status, error: statusError, refresh } = useStatus(auth === 'in');

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback<Notify>((message, kind = 'success') => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list.slice(-3), { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .get<{ authenticated: boolean; setupRequired?: boolean }>('/auth/me')
      .then((response) => {
        if (!alive) return;
        setSetupRequired(response.setupRequired ?? false);
        setAuth(response.authenticated ? 'in' : 'out');
      })
      .catch(() => {
        if (!alive) return;
        setSetupRequired(false);
        setAuth('out');
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: PageKey) => {
    setPage(next);
    setMobileOpen(false);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  }, []);

  const login = async (password: string) => {
    setLoginBusy(true);
    setLoginError('');
    try {
      if (setupRequired) {
        await api.post('/auth/setup', { password });
        setSetupRequired(false);
      } else {
        await api.post('/auth/login', { password });
      }
      setAuth('in');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setLoginBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* clear locally regardless */
    }
    setAuth('out');
    setToasts([]);
  };

  if (auth === 'checking') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
          <Bot className="h-6 w-6" />
        </span>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking session…
        </p>
      </div>
    );
  }

  if (auth === 'out') {
    return (
      <Login
        onSubmit={(password) => void login(password)}
        error={loginError}
        busy={loginBusy}
        setupRequired={setupRequired}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        page={page}
        onNavigate={navigate}
        status={status}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          page={page}
          status={status}
          onMenu={() => setMobileOpen(true)}
          onNavigate={navigate}
          onSignOut={() => void signOut()}
        />

        <main className="flex-1 overflow-y-auto scrollbar-thin">
          {!status ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Connecting to the manager…</p>
              {statusError && (
                <div className="space-y-2">
                  <p className="text-xs text-red-300">{statusError}</p>
                  <Button size="sm" variant="outline" onClick={() => void refresh()}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div key={page} className="mx-auto w-full max-w-[1400px] animate-fade-up p-4 sm:p-6 lg:p-8">
              {page === 'team' && <TeamPage status={status} onNavigate={navigate} notify={notify} />}
              {page === 'agents' && <AgentsPage notify={notify} defaultModel={status.manager.defaultModel} />}
              {page === 'conversations' && <ConversationsPage notify={notify} />}
              {page === 'knowledge' && <KnowledgePage notify={notify} />}
              {page === 'mcp' && <McpPage notify={notify} />}
              {page === 'settings' && <SettingsPage notify={notify} refreshStatus={refresh} />}
              {page === 'logs' && <LogsPage />}
              <AnnotationOverlay />
            </div>
          )}
        </main>
      </div>

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </div>
  );
}
