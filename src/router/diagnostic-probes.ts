import { RunnerNotFoundError } from '../runner-adapter/errors';
import { SelectorError } from './communication-client';

export type WatcherStatus = 'ok' | 'degraded' | 'failing' | 'not_configured';

export interface SystemHealthCheck {
  runner: 'reachable' | 'unreachable' | 'not_configured' | 'unknown';
  checkedAt: string;
  watcher?: WatcherStatus;
  watcherAlarmId?: string | null;
  watcherReasons?: string[];
  openIncidents?: number;
  staleSources?: string[];
}

export interface SystemHealthReport {
  runner: SystemHealthCheck['runner'];
  watcher: WatcherStatus;
  openIncidents: number;
  staleSources: string[];
}

export interface WatcherHealthEnv {
  ERROR_WATCHER_URL?: string;
  ERROR_WATCHER_KEY?: string;
}

export interface WatcherHealthReport {
  watcher: WatcherStatus;
  watcherAlarmId: string | null;
  watcherReasons: string[];
  watcherOpenIncidents: number;
  watcherStaleSources: string[];
}

export async function probeRunnerHealth(adapter: { status: (runId: string) => Promise<unknown> } | null, timeoutMs = 5_000): Promise<SystemHealthCheck> {
  let runner: SystemHealthCheck['runner'] = 'not_configured';
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (adapter) {
    try {
      await Promise.race([adapter.status('probe-run'), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SelectorError('probe_timeout')), timeoutMs); })]);
      runner = 'reachable';
    } catch (error) { runner = error instanceof RunnerNotFoundError ? 'reachable' : 'unreachable'; }
    finally { clearTimeout(timer); }
  }
  return { runner, checkedAt: new Date().toISOString() };
}

const WATCHER_SCOPES = 'error:read';

export async function probeWatcherHealth(env: WatcherHealthEnv, timeoutMs = 5_000): Promise<WatcherHealthReport> {
  const unavailable: WatcherHealthReport = { watcher: 'not_configured', watcherAlarmId: null, watcherReasons: [], watcherOpenIncidents: 0, watcherStaleSources: [] };
  const url = env.ERROR_WATCHER_URL?.trim();
  const key = env.ERROR_WATCHER_KEY?.trim();
  if (!url || !key) return unavailable;
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      headers: { 'x-watcher-key': key, 'x-watcher-scopes': WATCHER_SCOPES },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return unavailable;
    const body = await response.json() as { status?: unknown; reasons?: unknown; alarmId?: unknown; summary?: { openIncidents?: unknown; staleSources?: unknown } };
    if (body.status !== 'ok' && body.status !== 'degraded' && body.status !== 'failing') return unavailable;
    const reasons = Array.isArray(body.reasons) ? body.reasons.filter((entry): entry is string => typeof entry === 'string') : [];
    const stale = body.summary?.staleSources;
    const staleSources = Array.isArray(stale) ? stale.filter((entry): entry is string => typeof entry === 'string') : [];
    const openIncidents = Number(body.summary?.openIncidents ?? 0);
    return {
      watcher: body.status,
      watcherAlarmId: typeof body.alarmId === 'string' ? body.alarmId : null,
      watcherReasons: reasons,
      watcherOpenIncidents: Number.isFinite(openIncidents) ? openIncidents : 0,
      watcherStaleSources: staleSources,
    };
  } catch {
    return unavailable;
  }
}

