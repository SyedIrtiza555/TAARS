import type { ComponentType } from 'react';
import {
  BookOpen,
  Bot,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  PlugZap,
  ScrollText,
  Settings,
  Smartphone,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { AppStatus } from '../lib/types';
import { Badge } from './ui';

export type PageKey =
  | 'team'
  | 'agents'
  | 'conversations'
  | 'knowledge'
  | 'mcp'
  | 'settings'
  | 'logs';

export const NAV: Array<{
  key: PageKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { key: 'team', label: 'Team', icon: Users },
  { key: 'agents', label: 'Agents', icon: Smartphone },
  { key: 'conversations', label: 'Chats', icon: MessagesSquare },
  { key: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { key: 'mcp', label: 'MCP Tools', icon: PlugZap },
  { key: 'settings', label: 'Settings', icon: Settings },
  { key: 'logs', label: 'Logs & runs', icon: ScrollText },
];

export function isPageKey(value: string): value is PageKey {
  return NAV.some((item) => item.key === value);
}

function NavList(props: { page: PageKey; onNavigate: (page: PageKey) => void }) {
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = props.page === item.key;
        return (
          <button
            key={item.key}
            type="button"
            data-active={active}
            onClick={() => props.onNavigate(item.key)}
            className="nav-item w-full"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
            {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-5 py-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-glow">
        <Bot className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight">Agent Manager</p>
        <p className="truncate text-[11px] text-muted-foreground">WhatsApp AI workforce control room</p>
      </div>
    </div>
  );
}

export function Sidebar(props: {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  status: AppStatus | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {props.open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={props.onClose}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-border bg-card/70 backdrop-blur-xl transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0',
          props.open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between lg:block">
          <Brand />
          <button
            type="button"
            aria-label="Close navigation"
            onClick={props.onClose}
            className="mr-3 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <NavList page={props.page} onNavigate={props.onNavigate} />

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background/40 px-3 py-2.5 text-left">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium">OpenCode runtime</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {props.status?.hub.runtimeReady ? 'ready' : 'starts on demand'}
              </span>
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </div>
          <p className="mt-2 px-1 text-[10px] text-muted-foreground">
            v{props.status?.server.version ?? '2.0.0'}
          </p>
        </div>
      </aside>
    </>
  );
}

export function TopBar(props: {
  page: PageKey;
  status: AppStatus | null;
  onMenu: () => void;
  onNavigate: (page: PageKey) => void;
  onSignOut: () => void;
}) {
  const item = NAV.find((entry) => entry.key === props.page);

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={props.onMenu}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-glow lg:hidden">
            <Bot className="h-4 w-4" />
          </span>
          <span className="hidden text-muted-foreground sm:inline">Workspace</span>
          <ChevronRight className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
          <span className="truncate font-medium">{item?.label}</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden max-w-36 truncate text-xs text-muted-foreground md:block">
            {props.status?.manager.defaultModel || '—'}
          </span>
          <button
            type="button"
            onClick={props.onSignOut}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
