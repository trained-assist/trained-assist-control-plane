/**
 * Envelope приёма задачи по контракту C01 (contracts/README.md, принят 02.10.2026).
 * Имена полей — предложение из контракта; здесь они зафиксированы для control plane.
 *
 * Принципал НЕ приходит из тела запроса: он выводится из проверенной аутентификации
 * (C01: «Principal, endpoint и доступ к project/session выводятся из проверенной
 * аутентификации, а не принимаются на доверии от модели»). Поэтому principalId —
 * параметр admit(), а не поле envelope.
 */

export const ADMISSION_CONTRACT_VERSION = 1;

/** Один элемент входа: текст и/или ссылки на артефакты (C01 inputItems/artifactRefs). */
export interface IntakeItem {
  text?: string;
  artifactRefs?: string[];
  /**
   * Снимок workspace предыдущего рана (Runner, issue #52 шаг 1): байты лежат в долговечном
   * хранилище, а ран получает их в свой workspace с проверкой владельца и дайджеста.
   * Версию/путь назначает хост, клиент только называет снимок.
   */
  snapshotId?: string;
}

export interface IntakeEnvelope {
  contractVersion: number;
  /** Ключ идемпотентности приёма; scope ключа = (profileId, requestId). */
  requestId: string;
  /** Диалог-источник (conversationRef). Для headless API может отсутствовать. */
  conversationRef?: string | null;
  /** Сессия движка/источника (sessionId) -> durable_tasks.origin_session_id. */
  sessionId?: string | null;
  projectId?: string | null;
  /** Аудитория и адрес доставки, записанные ПРИ ПРИЁМЕ (INV-19). */
  audienceId?: string | null;
  destinationId?: string | null;
  inputItems: IntakeItem[];
  /** Исполнение запрошено сейчас или только принято (C01: receipt != запуск). */
  requestedExecutionPolicy?: string | null;
  /** Куда клиент ждёт ответа/событий (C01 replyToRef). */
  replyToRef?: string | null;
  /** Политика ожидания ответа пользователя, если приём сразу запускает план. */
  question?: string | null;
  waitTimeoutSec?: number | null;
}

export class InvalidEnvelopeError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'InvalidEnvelopeError';
  }
}

const MAX_ITEMS = 32;
const MAX_ITEM_CHARS = 8000;

export function normalizeEnvelope(raw: unknown): IntakeEnvelope {
  if (typeof raw !== 'object' || raw === null) throw new InvalidEnvelopeError('envelope must be an object', 'envelope');
  const e = raw as Record<string, unknown>;

  const requestId = typeof e.requestId === 'string' ? e.requestId.trim() : '';
  if (!requestId) throw new InvalidEnvelopeError('requestId is required', 'requestId');
  if (requestId.length > 200) throw new InvalidEnvelopeError('requestId is too long', 'requestId');

  const contractVersion = e.contractVersion === undefined ? ADMISSION_CONTRACT_VERSION : Number(e.contractVersion);
  if (!Number.isInteger(contractVersion) || contractVersion < 1) {
    throw new InvalidEnvelopeError('contractVersion must be a positive integer', 'contractVersion');
  }

  const rawItems = e.inputItems === undefined ? [] : e.inputItems;
  if (!Array.isArray(rawItems)) throw new InvalidEnvelopeError('inputItems must be an array', 'inputItems');
  if (rawItems.length === 0) throw new InvalidEnvelopeError('inputItems must not be empty', 'inputItems');
  if (rawItems.length > MAX_ITEMS) throw new InvalidEnvelopeError('inputItems exceeds limit', 'inputItems');

  const inputItems: IntakeItem[] = rawItems.map((item, i) => {
    if (typeof item === 'string') return { text: item };
    if (typeof item !== 'object' || item === null) {
      throw new InvalidEnvelopeError(`inputItems[${i}] must be a string or object`, 'inputItems');
    }
    const it = item as Record<string, unknown>;
    const text = typeof it.text === 'string' ? it.text : undefined;
    const refs = it.artifactRefs === undefined ? undefined : it.artifactRefs;
    if (refs !== undefined && (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string'))) {
      throw new InvalidEnvelopeError(`inputItems[${i}].artifactRefs must be string[]`, 'inputItems');
    }
    const snapshotId = typeof it.snapshotId === 'string' ? it.snapshotId.trim() : undefined;
    if (snapshotId !== undefined) {
      if (snapshotId.length === 0 || snapshotId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(snapshotId)) {
        throw new InvalidEnvelopeError(`inputItems[${i}].snapshotId: expected an id matching [A-Za-z0-9][A-Za-z0-9._:-]*`, 'inputItems');
      }
    }
    if (text === undefined && (refs === undefined || refs.length === 0) && snapshotId === undefined) {
      throw new InvalidEnvelopeError(`inputItems[${i}] must have text, artifactRefs or snapshotId`, 'inputItems');
    }
    if (text !== undefined && text.length > MAX_ITEM_CHARS) {
      throw new InvalidEnvelopeError(`inputItems[${i}].text is too long`, 'inputItems');
    }
    return { text, artifactRefs: refs as string[] | undefined, snapshotId };
  });

  const str = (key: string): string | null => {
    const v = e[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new InvalidEnvelopeError(`${key} must be a string`, key);
    return v;
  };

  let waitTimeoutSec: number | null = null;
  if (e.waitTimeoutSec !== undefined && e.waitTimeoutSec !== null) {
    const n = Number(e.waitTimeoutSec);
    if (!Number.isInteger(n) || n < 1 || n > 30 * 24 * 3600) {
      throw new InvalidEnvelopeError('waitTimeoutSec must be 1..2592000', 'waitTimeoutSec');
    }
    waitTimeoutSec = n;
  }

  return {
    contractVersion,
    requestId,
    conversationRef: str('conversationRef'),
    sessionId: str('sessionId'),
    projectId: str('projectId'),
    audienceId: str('audienceId'),
    destinationId: str('destinationId'),
    inputItems,
    requestedExecutionPolicy: str('requestedExecutionPolicy'),
    replyToRef: str('replyToRef'),
    question: str('question'),
    waitTimeoutSec,
  };
}

/** goal задачи = текст первого элемента входа (durable_tasks.goal NOT NULL). */
export function goalOf(envelope: IntakeEnvelope): string {
  const text = envelope.inputItems
    .map((item) => item.text ?? '')
    .filter((t) => t.length > 0)
    .join('\n')
    .trim();
  return text || `[артефакты: ${envelope.inputItems.flatMap((i) => i.artifactRefs ?? []).join(', ')}]`;
}

export function artifactRefsOf(envelope: IntakeEnvelope): string[] {
  return envelope.inputItems.flatMap((item) => item.artifactRefs ?? []);
}

/**
 * Канонический хэш значимой части envelope: повтор того же requestId с тем же
 * payload -> прежняя квитанция; с другим payload -> conflict (C01). Ключ сам
 * (requestId) и транспортные поля в хэш не входят.
 */
/** Рекурсивная канонизация: ключи объектов отсортированы, порядок стабилен. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function canonicalEnvelopeJson(envelope: IntakeEnvelope): string {
  const significant = {
    contractVersion: envelope.contractVersion,
    conversationRef: envelope.conversationRef ?? null,
    sessionId: envelope.sessionId ?? null,
    projectId: envelope.projectId ?? null,
    audienceId: envelope.audienceId ?? null,
    destinationId: envelope.destinationId ?? null,
    inputItems: envelope.inputItems.map((item) => ({ text: item.text ?? null, artifactRefs: item.artifactRefs ?? [] })),
    requestedExecutionPolicy: envelope.requestedExecutionPolicy ?? null,
    question: envelope.question ?? null,
    waitTimeoutSec: envelope.waitTimeoutSec ?? null,
  };
  return JSON.stringify(canonicalize(significant));
}

/** SHA-256 канонической формы в hex; WebCrypto доступен и в Workers, и в Node 20+. */
export async function envelopeHash(envelope: IntakeEnvelope): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalEnvelopeJson(envelope));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}