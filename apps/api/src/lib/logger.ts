import { hostname } from 'node:os';
import { env, isProduction } from '../env.js';
import { redact } from './redact.js';
import { currentRequestId } from './requestContext.js';

/**
 * Structured logging, in pino's record format and deliberately not pino.
 *
 * The format is pino's exactly - numeric `level`, epoch-millisecond `time`,
 * `pid`, `hostname`, `msg`, bindings flattened alongside them - because that is
 * what the tools downstream already read. `pino-pretty` renders these lines,
 * every hosted log platform has a pino preset, and swapping this module for the
 * real thing is a dependency and a factory call rather than a rewrite of every
 * call site. See docs/observability.md for that swap.
 *
 * What it is not is a general-purpose logger: no transports, no worker thread,
 * no serialiser registry. This app writes NDJSON to stdout and lets the process
 * manager own the file, which is the whole of what a twelve-factor service
 * needs, and about a hundred lines of it.
 *
 * Everything emitted goes through `redact` first - see that module for why the
 * scrubbing lives here rather than at the call sites.
 */

export const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type LevelName = keyof typeof LEVELS;
export type LevelSetting = LevelName | 'silent';
export type LogFormat = 'json' | 'pretty';

export interface Logger {
  /** The threshold this logger emits at. Bindings are inherited; this is not overridden per child. */
  readonly level: LevelSetting;
  /** A logger that stamps `bindings` on every record, in pino's `child` sense. */
  child(bindings: Record<string, unknown>): Logger;
  isLevelEnabled(level: LevelName): boolean;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
}

/** pino's call shape: a message, or a record of fields and then a message. */
export interface LogFn {
  (message: string): void;
  (fields: Record<string, unknown>, message?: string): void;
}

export interface LoggerOptions {
  level?: LevelSetting;
  format?: LogFormat;
  /** Stamped on every record, before bindings. */
  base?: Record<string, unknown>;
  /** Where a finished line goes. Swapped in tests; stdout everywhere else. */
  destination?: (line: string) => void;
  /** Injected only so a test can assert an exact `time`. */
  now?: () => number;
}

function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface LoggerState {
  level: LevelSetting;
  threshold: number;
  format: LogFormat;
  base: Record<string, unknown>;
  destination: (line: string) => void;
  now: () => number;
}

function thresholdOf(level: LevelSetting): number {
  return level === 'silent' ? Number.POSITIVE_INFINITY : LEVELS[level];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const state: LoggerState = {
    level,
    threshold: thresholdOf(level),
    format: options.format ?? 'json',
    base: options.base ?? {},
    destination: options.destination ?? writeToStdout,
    now: options.now ?? Date.now,
  };
  return build(state, {});
}

function build(state: LoggerState, bindings: Record<string, unknown>): Logger {
  const emit = (level: LevelName, first: unknown, second?: string): void => {
    if (LEVELS[level] < state.threshold) return;

    const fields =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    const message = fields ? second : typeof first === 'string' ? first : String(first);

    const record: Record<string, unknown> = {
      level: LEVELS[level],
      time: state.now(),
      pid: process.pid,
      hostname: hostname(),
      ...state.base,
      ...bindings,
    };

    /*
     * From the async context rather than from the caller, so a log line written
     * four calls deep inside a service carries the request that caused it
     * without anything in between having been given it. An explicit
     * `requestId` in the fields still wins - the client-error route logs a
     * browser's id, not the id of the POST that delivered it.
     */
    const requestId = currentRequestId();
    if (requestId !== undefined && !('requestId' in record)) record.requestId = requestId;

    if (fields) {
      for (const [key, value] of Object.entries(fields)) record[key] = value;
    }
    if (message !== undefined) record.msg = message;

    const safe = redact(record) as Record<string, unknown>;

    try {
      state.destination(state.format === 'pretty' ? formatPretty(safe) : JSON.stringify(safe));
    } catch {
      /*
       * A logger that throws turns a handled error into an unhandled one, at
       * the exact moment somebody is trying to find out what happened. There is
       * nowhere left to report this to, so it is dropped on purpose.
       */
    }
  };

  const at =
    (level: LevelName): LogFn =>
    (first: unknown, second?: string) =>
      emit(level, first, second);

  return {
    level: state.level,
    child: (extra) => build(state, { ...bindings, ...extra }),
    isLevelEnabled: (level) => LEVELS[level] >= state.threshold,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
  };
}

const LEVEL_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(LEVELS).map(([name, value]) => [value, name.toUpperCase()]),
);

/** Carried by the line's own shape in pretty mode, so not repeated as `key=value`. */
const PRETTY_HEADER_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname']);

/**
 * For a person watching `pnpm dev`. NDJSON is right for a log collector and
 * unreadable in a terminal, and a developer who cannot read their own log
 * stops looking at it.
 */
function formatPretty(record: Record<string, unknown>): string {
  const { level, time, msg } = record;

  const stamp = typeof time === 'number' ? new Date(time).toISOString() : '';
  const name = (typeof level === 'number' ? LEVEL_NAMES[level] : undefined) ?? 'INFO';

  const parts: string[] = [];
  let stack: string | undefined;

  for (const [key, value] of Object.entries(record)) {
    if (PRETTY_HEADER_KEYS.has(key)) continue;
    if (key === 'err' && typeof value === 'object' && value !== null) {
      const err = value as { type?: unknown; message?: unknown; stack?: unknown };
      parts.push(`err=${String(err.type ?? 'Error')}: ${String(err.message ?? '')}`);
      if (typeof err.stack === 'string') stack = err.stack;
      continue;
    }
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  const head = `${stamp} ${name.padEnd(5)} ${typeof msg === 'string' ? msg : ''}`.trimEnd();
  const line = parts.length > 0 ? `${head} ${parts.join(' ')}` : head;
  return stack === undefined ? line : `${line}\n${stack}`;
}

/*
 * The one seam the tests use. The root logger is a module singleton so that any
 * module can `import { logger }` without being handed one, which leaves no
 * constructor call for a test to intercept - so interception happens here
 * instead, and children read it lazily through the closure above.
 */
let destination: (line: string) => void = writeToStdout;

/** Redirects every line, including from children already created. Pass nothing to restore stdout. */
export function setLogDestination(next?: (line: string) => void): void {
  destination = next ?? writeToStdout;
}

/**
 * The application logger.
 *
 * JSON in production because something machine-readable is collecting it;
 * pretty elsewhere because a person is reading it. `LOG_FORMAT` overrides both
 * — a container in staging that a human tails wants pretty, and a developer
 * debugging their log pipeline wants JSON.
 */
export const logger: Logger = createLogger({
  level: env.LOG_LEVEL,
  format: env.LOG_FORMAT ?? (isProduction ? 'json' : 'pretty'),
  destination: (line) => {
    destination(line);
  },
});
