/**
 * Task Reporting — read model over Task Store (ARCHITECTURE §3, USER-TASK-IDS-AND-REPORTING §8).
 *
 * Reporting показывает по userTaskId: очередь, подготовку, запуск, ошибку,
 * следующего исполнителя, эскалацию, ожидание пользователя и итог.
 * Не запускает работу, не повторяет её, не выбирает escalation — query/read model.
 *
 * Потребители: HTTP /report, web refresh, gateway status, Monitoring.
 * Все операции авторизованы по caller scope — здесь только чтение.
 */
import { TaskStore } from '../taskstore';
import type { TaskRow } from '../taskstore/types';
import { logStructured } from '../logging/structured-log';

export interface ReportArtifact {
  /** Ссылка на артефакт (storage key или outputRef). */
  ref: string;
  kind: string;
  sizeBytes: number | null;
  /** SHA-256 в hex без префикса; null, если манифест не отдал контрольную сумму. */
  sha256: string | null;
  runId: string | null;
}

export interface ReportSnapshot {
  userTaskId: string;
  profileId: string;
  status: string;
  stage: string | null;
  generation: number;
  revision: number;
  deliveryState: string | null;
  awaitingInputId: string | null;
  result: unknown;
  /**
   * Конечный текст движка (`result.answer`), а не ответ человека: клиент
   * получает ровно то, что вернул движок. `null` означает «движок не ответил»
   * и никогда не выдаётся за пустой ответ.
   */
  answer: string | null;
  /** Манифесты выходов: ссылка + размер + контрольная сумма. */
  artifacts: ReportArtifact[];
  /** Ответ человека (если был явный host ask). Не источник результата. */
  userAnswer: string | null;
  conversationId: string | null;
  updatedAt: number | null;
}

export interface ReportEvent {
  eventId: string | null;
  sequence: number;
  kind: string;
  occurredAt: number;
  payload: Record<string, unknown>;
}

export interface ReportHistory {
  snapshot: ReportSnapshot;
  events: ReportEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface ReportView {
  snapshot: ReportSnapshot;
  latestEventSequence: number;
  eventCount: number;
}

/**
 * Краткий снапшот задачи — одна транзакция чтения.
 *
 * `answer` берётся из структурированного результата шага (`result.answer`), а
 * `userAnswer` — рядом и отдельно: отчёт не даёт перепутать ответ человека с
 * ответом движка. Артефакты приходят как манифесты (размер + контрольная
 * сумма), чтобы клиент мог проверить скачанное, а не только получить ссылку.
 */
export async function reportSnapshot(store: TaskStore, userTaskId: string): Promise<ReportSnapshot> {
  const task = await store.getTask(userTaskId);
  if (!task) throw new Error(`task not found: ${userTaskId}`);
  const artifacts = await store.listArtifacts(userTaskId);
  const result = task.result_json ? (JSON.parse(task.result_json) as Record<string, unknown>) : null;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    userTaskId: task.id,
    profileId: task.profile_id,
    status: task.status,
    stage: task.stage,
    generation: task.generation,
    revision: task.revision,
    deliveryState: task.delivery_state,
    awaitingInputId: task.awaiting_input_id,
    result,
    answer: text(result?.['answer'] ?? null),
    userAnswer: text(result?.['userAnswer'] ?? null),
    artifacts: artifacts.map((a) => ({
      ref: a.artifact_ref,
      kind: a.kind,
      sizeBytes: a.size_bytes ?? null,
      sha256: a.checksum?.startsWith('sha256:') ? a.checksum.slice('sha256:'.length) : null,
      runId: a.run_id ?? null,
    })),
    conversationId: task.conversation_id,
    updatedAt: task.updated_at,
  };
}

/** Страница журнала задачи — курсор C02, без нового execution и без LLM. */
export async function reportHistory(
  store: TaskStore,
  userTaskId: string,
  after: number | null = null,
  limit: number = 100,
): Promise<ReportHistory> {
  const snapshot = await reportSnapshot(store, userTaskId);
  const page = await store.eventsAfter(userTaskId, after, limit);
  return {
    snapshot,
    events: page.events.map((e) => ({
      eventId: e.event_id,
      sequence: e.id,
      kind: e.kind,
      occurredAt: e.created_at,
      payload: e.payload_json ? JSON.parse(e.payload_json) : {},
    })),
    cursor: page.nextCursor ?? snapshot.updatedAt ?? 0,
    hasMore: page.hasMore,
  };
}

/** Полный отчёт: снапшот + счётчик событий (без загрузки тела — лёгкий). */
export async function reportView(store: TaskStore, userTaskId: string): Promise<ReportView> {
  const snapshot = await reportSnapshot(store, userTaskId);
  const history = await store.history(userTaskId);
  return {
    snapshot,
    latestEventSequence: history.length ? history[history.length - 1]!.id : 0,
    eventCount: history.length,
  };
}

/** Структурированный лог отчёта (AC-110: profileId/userTaskId/runId/ключи событий). */
export function logReport(fields: {
  event: string;
  userTaskId: string;
  profileId?: string | null;
  runId?: string | null;
  reason?: string | null;
  [key: string]: unknown;
}): void {
  logStructured({ ...fields, event: `report.${fields.event}`, userTaskId: fields.userTaskId, profileId: fields.profileId ?? null, runId: fields.runId ?? null, reason: fields.reason ?? null });
}