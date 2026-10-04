/**
 * Данные для рецепта готовит ХОСТ, а не модель (P17; §5, §11.2 шаг 5).
 *
 * Если fast path требует данных из системы, их приносит host-owned
 * детерминированный обработчик по ПРОВЕРЕННОМУ снимку (Task Store, состояние
 * подключений, часы). Модель не выбирает backend, URL и секреты из текста и не
 * вызывает capability сама: она получает уже подготовленные `preparedData` и
 * только решает, достаточно ли их для ответа.
 *
 * Исход обработчика — по §11.4, сокращённый до того, что нужно рецепту:
 * completed / missing_input / blocked / needs_agent / technical_error.
 * `needs_agent` — решение ХОСТА (нет объявленной возможности или нет права), а не
 * догадка модели: эскалация за живыми данными остаётся за владельцем данных.
 */
import type { CapabilityEntry, HostFacts, PreparedInput } from '../router-types';
import { quotedSpansOf, textOutsideQuotes } from '../text-features';

export type HostHandlerOutcome = 'completed' | 'missing_input' | 'blocked' | 'needs_agent' | 'technical_error';

export interface PreparedCapabilityData {
  capabilityId: string;
  capabilityVersion: number;
  outcome: HostHandlerOutcome;
  /** Значения конкретного вызова: только факты снимка, без секретов. */
  values: Record<string, string | number | boolean | null>;
  /** Адресные ссылки на источник: их видит и модель, и журнал. */
  evidenceRefs: string[];
  missingInputs: string[];
  blockedReason: string | null;
  /** Причина эскалации, если обработчик решил, что нужен исполнитель. */
  needsAgentReason: string | null;
}

export interface HostCapabilityHandlerParams {
  capabilityId: string;
  hostFacts: HostFacts;
  prepared: PreparedInput;
}

export type HostCapabilityHandler = (params: HostCapabilityHandlerParams) => Promise<PreparedCapabilityData>;

/** Причины, по которым хост отказывается готовить данные без исполнителя. */
export const HOST_NEEDS_AGENT_REASONS = {
  NO_DECLARED_CAPABILITY: 'NO_DECLARED_CAPABILITY',
  INTEGRATION_NOT_CONNECTED: 'INTEGRATION_NOT_CONNECTED',
  EXTERNAL_EFFECT_NOT_ALLOWED: 'EXTERNAL_EFFECT_NOT_ALLOWED',
} as const;

export type HostNeedsAgentReason = (typeof HOST_NEEDS_AGENT_REASONS)[keyof typeof HOST_NEEDS_AGENT_REASONS];

/**
 * Обработчик песочницы: читает только снимок хоста. Никаких сетевых вызовов и
 * никаких секретов: готовность приходит из `HostFacts.connections`, задачи — из
 * `HostFacts.activeTasks`, часы — из `HostFacts.clockMs`.
 */
export function sandboxHostCapabilityHandler(): HostCapabilityHandler {
  return async ({ capabilityId, hostFacts, prepared }) => {
    const base: PreparedCapabilityData = {
      capabilityId,
      capabilityVersion: 1,
      outcome: 'technical_error',
      values: {},
      evidenceRefs: [],
      missingInputs: [],
      blockedReason: null,
      needsAgentReason: null,
    };
    switch (capabilityId) {
      case 'tasks.list_active': {
        return {
          ...base,
          outcome: 'completed',
          values: valuesOf({ count: hostFacts.activeTasks.length }),
          evidenceRefs: ['task_store:active_tasks'],
        };
      }
      case 'tasks.last': {
        const last = hostFacts.activeTasks[0];
        if (!last) {
          return { ...base, outcome: 'completed', values: valuesOf({ found: false }), evidenceRefs: ['task_store:active_tasks'] };
        }
        return { ...base, outcome: 'completed', values: valuesOf({ id: last.id, state: last.state }), evidenceRefs: [`task_store:${last.id}`] };
      }
      case 'tasks.by_day': {
        return {
          ...base,
          outcome: 'completed',
          values: valuesOf({ count: hostFacts.tasksYesterday.length }),
          evidenceRefs: ['task_store:tasks_by_day'],
        };
      }
      case 'clock.date_after': {
        return { ...base, outcome: 'completed', values: valuesOf({ clockMs: hostFacts.clockMs }), evidenceRefs: ['clock:system'] };
      }
      case 'integrations.connection_status': {
        const connected: Record<string, boolean> = {};
        for (const [id, value] of Object.entries(hostFacts.connections)) connected[id] = value === true;
        return { ...base, outcome: 'completed', values: valuesOf(connected), evidenceRefs: ['connection_state:all'] };
      }
      case 'google-drive.read': {
        if (hostFacts.connections['google-drive'] !== true) {
          return {
            ...base,
            outcome: 'blocked',
            blockedReason: HOST_NEEDS_AGENT_REASONS.INTEGRATION_NOT_CONNECTED,
            evidenceRefs: ['connection_state:google-drive'],
          };
        }
        return {
          ...base,
          outcome: 'needs_agent',
          needsAgentReason: HOST_NEEDS_AGENT_REASONS.NO_DECLARED_CAPABILITY,
          values: valuesOf({ connected: true }),
          evidenceRefs: ['connection_state:google-drive'],
        };
      }
      case 'google-drive.share_file': {
        const missing = ['email'].filter((field) => {
          const value = hostFacts.profileFields[field];
          return value === undefined || value === null || value === '';
        });
        if (missing.length > 0) {
          return { ...base, outcome: 'missing_input', missingInputs: missing, evidenceRefs: ['profile_fields:email'] };
        }
        if (hostFacts.connections['google-drive'] !== true) {
          return { ...base, outcome: 'blocked', blockedReason: HOST_NEEDS_AGENT_REASONS.INTEGRATION_NOT_CONNECTED, evidenceRefs: ['connection_state:google-drive'] };
        }
        return { ...base, outcome: 'needs_agent', needsAgentReason: HOST_NEEDS_AGENT_REASONS.EXTERNAL_EFFECT_NOT_ALLOWED, evidenceRefs: ['connection_state:google-drive'] };
      }
      default:
        return { ...base, outcome: 'technical_error', blockedReason: HOST_NEEDS_AGENT_REASONS.NO_DECLARED_CAPABILITY };
    }
  };
}

/** Значения снимка: только факты, без секретов и без undefined. */
function valuesOf(values: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return values;
}

/** Ссылка на частичный результат обработчика: агент не повторяет сделанное. */
export function partialResultRefOf(data: PreparedCapabilityData): string | null {
  if (data.outcome === 'completed') return `host:${data.capabilityId}`;
  if (data.outcome === 'missing_input') return `host:${data.capabilityId}:missing_input`;
  return null;
}

/** Является ли обработчик объявленной capability каталога (проверка по снимку). */
export function isDeclaredCapability(entry: CapabilityEntry | null, capabilityId: string): boolean {
  return entry !== null && entry.id === capabilityId;
}

/**
 * Ограничения, которые ХОСТ извлёк из исходного текста (§11.3: reformulation их
 * не отбрасывает). Извлечение — только вне цитат и только явные запреты:
 * модель не может ни добавить, ни убрать ограничение, а переформулированная цель
 * дополняет исходный запрос.
 */
const HOST_CONSTRAINTS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'no_publish', pattern: /не\s+(?:публик\w*|выкладыва\w*|размещ\w*|пост\w*)/i },
  { id: 'no_send', pattern: /не\s+(?:отправ\w*|посыла\w*|высыла\w*|пересыла\w*)/i },
  { id: 'no_payment', pattern: /не\s+(?:плат\w*|оплачива\w*|списыва\w*)/i },
  { id: 'text_only', pattern: /только\s+(?:текст\w*|ответ\w*|проект\w*|план\w*)/i },
];

export function hostConstraintsOf(text: string): string[] {
  const outside = textOutsideQuotes(text, quotedSpansOf(text));
  const found = HOST_CONSTRAINTS.filter((constraint) => constraint.pattern.test(outside)).map((constraint) => constraint.id);
  return Array.from(new Set(found));
}

/** Ограничения, запрещающие внешнее действие: их исполнителю нужно подтверждение. */
export const EFFECT_CONSTRAINT_IDS = ['no_publish', 'no_send', 'no_payment'] as const;

/**
 * Требует ли исходный текст подтверждения перед внешним действием. Это решение
 * ХОСТА по извлечённым ограничениям, а не самооценка модели: запрет «не
 * публикуй» в исходном тексте обязан дойти до исполнителя как требование
 * подтверждения, даже если модель сказала `needsActions: false` (§11.3).
 */
export function hostRequiresExternalAction(constraints: string[]): boolean {
  return constraints.some((id) => (EFFECT_CONSTRAINT_IDS as readonly string[]).includes(id));
}
