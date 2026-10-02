/**
 * Конфигурация web-слоя: ТОЛЬКО из окружения.
 *
 * Ни URL подключения, ни ключ доступа не попадают в репозиторий, в файлы
 * конфигурации и в логи (правила эпика M1 и C13). Ключ читается либо из
 * переменной окружения, либо из файла, путь к которому тоже задан окружением
 * (`CONTROL_PLANE_API_KEY_FILE`) — так в песочницу попадает содержимое GCP
 * Secret Manager, а не сам секрет.
 */
import type { EventTransport } from './contract';

export interface WebConfig {
  /** Базовый URL control plane, напр. https://…workers.dev (без секретов). */
  controlPlaneUrl: string;
  /** Проверенная аутентификация (C01): идентичность для X-Principal. */
  principalId: string;
  /** Профиль песочницы — адресат задач в Task Store. */
  profileId: string;
  /** Необязательный bearer-ключ (C13, credential broker). В логи не идёт. */
  apiKey: string | null;
  /** sessionId источника (C01) -> origin_session_id. */
  sessionId: string | null;
  /** Таймаут HTTP-запроса к control plane, мс. */
  requestTimeoutMs: number;
  /** Интервал опроса журнала по курсору, мс. */
  pollIntervalMs: number;
  /** Как читать журнал: `auto` — курсор C02, при отсутствии `/events` — /status. */
  eventTransport: 'auto' | EventTransport;
  /** Сколько ходов максимум восстанавливает rebuild индекса разговора. */
  maxTurns: number;
}

export type WebEnv = Record<string, string | undefined>;

export class WebConfigError extends Error {
  constructor(
    message: string,
    public readonly variable: string,
  ) {
    super(message);
    this.name = 'WebConfigError';
  }
}

const num = (env: WebEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new WebConfigError(`${name} must be a number in ${min}..${max}`, name);
  }
  return value;
};

const requireVar = (env: WebEnv, name: string): string => {
  const value = (env[name] ?? '').trim();
  if (!value) throw new WebConfigError(`${name} is required (env only; nothing is read from the repo)`, name);
  return value;
};

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export interface ConfigReaders {
  /** Чтение файла с ключом (Node-прогоны). В worker runtime fs недоступен. */
  readFileSync?: (path: string) => string;
}

/**
 * Ключ доступа: из `CONTROL_PLANE_API_KEY` либо из файла
 * `CONTROL_PLANE_API_KEY_FILE`. Возвращается наружу только для заголовка;
 * ни `logWeb`, ни страница его не печатают.
 */
const readApiKey = (env: WebEnv, readers: ConfigReaders): string | null => {
  const direct = (env['CONTROL_PLANE_API_KEY'] ?? '').trim();
  if (direct) return direct;
  const path = (env['CONTROL_PLANE_API_KEY_FILE'] ?? '').trim();
  if (!path) return null;
  if (!readers.readFileSync) {
    throw new WebConfigError(
      'CONTROL_PLANE_API_KEY_FILE requires a runtime file reader; inject CONTROL_PLANE_API_KEY from your secret store',
      'CONTROL_PLANE_API_KEY_FILE',
    );
  }
  const fromFile = readers.readFileSync(path).trim();
  if (!fromFile) throw new WebConfigError('CONTROL_PLANE_API_KEY_FILE is empty', 'CONTROL_PLANE_API_KEY_FILE');
  return fromFile;
};

export function readWebConfig(env: WebEnv, readers: ConfigReaders = {}): WebConfig {
  const transport = (env['WEB_EVENT_TRANSPORT'] ?? 'auto').trim();
  if (!['auto', 'events-endpoint', 'status-history'].includes(transport)) {
    throw new WebConfigError('WEB_EVENT_TRANSPORT must be auto|events-endpoint|status-history', 'WEB_EVENT_TRANSPORT');
  }
  const config: WebConfig = {
    controlPlaneUrl: stripTrailingSlash(requireVar(env, 'CONTROL_PLANE_URL')),
    principalId: requireVar(env, 'CONTROL_PLANE_PRINCIPAL'),
    profileId: requireVar(env, 'CONTROL_PLANE_PROFILE'),
    apiKey: readApiKey(env, readers),
    sessionId: (env['CONTROL_PLANE_SESSION_ID'] ?? '').trim() || null,
    requestTimeoutMs: num(env, 'WEB_REQUEST_TIMEOUT_MS', 5_000, 100, 60_000),
    pollIntervalMs: num(env, 'WEB_POLL_INTERVAL_MS', 250, 10, 10_000),
    eventTransport: transport as 'auto' | EventTransport,
    maxTurns: num(env, 'WEB_MAX_TURNS', 32, 1, 512),
  };
  return config;
}

/** Транспорт чтения ключа: для логов и отчётов (само значение ключа не пишется). */
export function authScheme(config: WebConfig): 'x-principal' | 'x-principal+bearer' {
  return config.apiKey ? 'x-principal+bearer' : 'x-principal';
}