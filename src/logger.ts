import { bus } from './events.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogEntry = {
  id: number;
  at: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
};

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function safeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export class Logger {
  private static instance: Logger | null = null;
  private static counter = 0;
  private entries: LogEntry[] = [];
  private minLevel: LogLevel;
  private bindings: Record<string, unknown>;
  private base: Logger | null = null;

  constructor(minLevel: LogLevel = 'info', bindings: Record<string, unknown> = {}, base?: Logger) {
    this.minLevel = minLevel;
    this.bindings = bindings;
    this.base = base ?? null;
  }

  static init(minLevel: LogLevel): Logger {
    Logger.instance = new Logger(minLevel);
    return Logger.instance;
  }

  static get(): Logger {
    if (!Logger.instance) Logger.instance = new Logger('info');
    return Logger.instance;
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.minLevel, { ...this.bindings, ...bindings }, this.base ?? this);
  }

  getHistory(limit = 200): LogEntry[] {
    const source = this.base ?? this;
    return source.entries.slice(-limit);
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;

    let meta: Record<string, unknown> | undefined = { ...this.bindings };
    let message = '';

    for (const arg of args) {
      if (arg && typeof arg === 'object' && !(arg instanceof Error) && !Array.isArray(arg)) {
        meta = { ...(meta ?? {}), ...(arg as Record<string, unknown>) };
      } else {
        message = message ? `${message} ${stringifyArg(arg)}` : stringifyArg(arg);
      }
    }

    for (const [key, value] of Object.entries(meta ?? {})) {
      meta![key] = safeValue(value);
    }
    if (Object.keys(meta ?? {}).length === 0) meta = undefined;

    const target = this.base ?? this;
    const entry: LogEntry = {
      id: ++Logger.counter,
      at: new Date().toISOString(),
      level,
      message: message || '(no message)',
      meta,
    };
    target.entries.push(entry);
    if (target.entries.length > 400) target.entries.splice(0, target.entries.length - 400);
    bus.publish('log', entry);

    // Print every message that passed the level check above so a healthy
    // startup is always visible in the terminal. Previously only debug/trace
    // produced output, which made `npm run dev` look like it had died.
    const stamp = entry.at.slice(11, 19);
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${entry.message}${suffix}\n`;
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  trace(...args: unknown[]): void { this.write('trace', args); }
  debug(...args: unknown[]): void { this.write('debug', args); }
  info(...args: unknown[]): void { this.write('info', args); }
  warn(...args: unknown[]): void { this.write('warn', args); }
  error(...args: unknown[]): void { this.write('error', args); }
  fatal(...args: unknown[]): void { this.write('fatal', args); }
}

export const logger = Logger.init((process.env.LOG_LEVEL as LogLevel) || 'info');
export const createLogger = (name: string) => logger.child({ scope: name });
