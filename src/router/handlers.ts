/**
 * Исполнители fast path в песочнице (P16).
 *
 * Три разные вещи, и их нельзя смешивать:
 *  - `deterministic-handler` — код по данным системы (Task Store, часы,
 *    состояние подключений). Модели нет; выдумать здесь нечего.
 *  - `template-handler` — готовый ответ из каталога/политики, включая честный
 *    отказ: «сейчас не подключено», «нужен email», «лимит исчерпан».
 *  - `llm-recipe-job` — ОДИН ограниченный вызов модели без инструментов.
 *    Сам recipe вызывает P17; здесь он внедряется, чтобы песочница P16 могла
 *    проверить границы (валидный ответ / отказ / таймаут / обрезка) и чтобы
 *    отказ модели НЕ записывался как успех (PR-15, AC-129).
 *
 * Агентский исполнитель НЕ вызывается из этого модуля: `agentDispatch` только
 * СОБИРАЕТ заявку (AgentWorkOrder §11.5). Реальную отправку в Runner делает
 * M1.3/P17 — и только после host-проверки прав и бюджета.
 */
import type { CapabilityEntry, HostFacts, PreparedInput } from './router-types';

/** Ответ детерминированного обработчика: текст из данных системы. */
export interface DeterministicResult {
  text: string;
  /** Ссылки на источник данных (task id, connection id) — не содержимое секретов. */
  evidenceRefs: string[];
}

export interface TemplateResult {
  text: string;
  evidenceRefs: string[];
}

/** Исход recipe: валидный ответ или ТИПИЗИРОВАННЫЙ технический сбой. */
export type RecipeOutcome =
  | { kind: 'ok'; text: string; modelCalls: number }
  | { kind: 'refused'; text: string; modelCalls: number }
  | { kind: 'timeout'; modelCalls: number }
  | { kind: 'invalid_json'; modelCalls: number }
  | { kind: 'truncated'; modelCalls: number };

/** Рецепт P17: одна модель без инструментов по уже подготовленным данным. */
export interface RecipeRunner {
  (params: {
    decisionId: string;
    text: string;
    preparedData: Record<string, unknown> | null;
  }): Promise<RecipeOutcome>;
}

const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Ответы по данным хоста. Данные берутся из снимка (`HostFacts`), а не из
 * памяти модели: FR-001…FR-004, FR-055, FR-056.
 */
export function deterministicAnswer(
  capabilityId: string,
  facts: HostFacts,
  prepared: PreparedInput,
): DeterministicResult | null {
  switch (capabilityId) {
    case 'service.status': {
      const lines = facts.activeTasks.length
        ? facts.activeTasks.map((t) => `${t.id} — ${t.state}${t.title ? ` (${t.title})` : ''}`).join('; ')
        : 'задач нет';
      return { text: `Активные задачи: ${lines}`, evidenceRefs: ['task_store:active_tasks'] };
    }
    case 'tasks.list_active': {
      if (facts.activeTasks.length === 0) return { text: 'Сейчас задач нет.', evidenceRefs: ['task_store:active_tasks'] };
      const lines = facts.activeTasks.map((t) => `${t.id} — ${t.state}`).join('\n');
      return { text: `Сейчас в работе:\n${lines}`, evidenceRefs: ['task_store:active_tasks'] };
    }
    case 'tasks.last': {
      const last = facts.activeTasks[0];
      if (!last) return { text: 'Последних задач не найдено.', evidenceRefs: ['task_store:active_tasks'] };
      return { text: `Номер последней задачи: ${last.id}`, evidenceRefs: [`task_store:${last.id}`] };
    }
    case 'tasks.by_day': {
      const yesterday = facts.tasksYesterday;
      if (yesterday.length === 0) return { text: 'За вчера задач не найдено.', evidenceRefs: ['task_store:tasks_by_day'] };
      const lines = yesterday.map((t) => `${t.id}${t.title ? ` — ${t.title}` : ''}`).join('\n');
      return { text: `За вчера (${fmtDate(facts.clockMs - 86_400_000)}):\n${lines}`, evidenceRefs: ['task_store:tasks_by_day'] };
    }
    case 'clock.date_after': {
      const match = prepared.text.match(/через\s+(\w+)/i);
      const unit = match?.[1]?.toLowerCase() ?? '';
      const days = /недел/.test(unit) ? 7 * Number(/(\d+)/.exec(unit)?.[1] ?? '1') : Number(/(\d+)/.exec(unit)?.[1] ?? '1');
      const target = new Date(facts.clockMs + days * 86_400_000);
      return { text: `Через указанный срок будет ${fmtDate(target.getTime())} (по часам системы).`, evidenceRefs: ['clock:system'] };
    }
    case 'integrations.connection_status': {
      const integrationId = prepared.text.includes('диск') || prepared.text.includes('таблиц') ? 'google-drive' : 'unknown';
      if (integrationId === 'unknown') return null;
      const connected = facts.connections[integrationId] === true;
      return {
        text: connected ? 'Подключено.' : 'Сейчас не подключено.',
        evidenceRefs: [`connection_state:${integrationId}`],
      };
    }
    default:
      return null;
  }
}

/** Шаблонные ответы: только то, что уже известно политике/каталогу. */
export function templateAnswer(
  templateId: string | null,
  facts: HostFacts,
  capability: CapabilityEntry | null,
): TemplateResult | null {
  switch (templateId) {
    case 'service.help':
      return { text: 'Команды: /help, статус, стоп. Вопросы о том, что умею, — тоже без агента.', evidenceRefs: ['catalog:service.help'] };
    case 'catalog.brief': {
      const connected = Object.entries(facts.connections).filter(([, v]) => v).map(([k]) => k);
      const notConnected = Object.entries(facts.connections).filter(([, v]) => !v).map(([k]) => k);
      const parts = [`Подключено: ${connected.length ? connected.join(', ') : 'пока ничего'}.`];
      if (notConnected.length > 0) parts.push(`Не подключено: ${notConnected.join(', ')} — подключается в настройках профиля.`);
      return { text: parts.join(' '), evidenceRefs: ['connection_state:all'] };
    }
    case 'policy.model_facts':
      return {
        text: 'Отвечаю одной фиксированной моделью без инструментов; агент (OpenCode) включается только на живые данные и внешние действия. Стоимость считает биллинг, в ответе цифры не выдумываются.',
        evidenceRefs: ['policy:fast-path-v1'],
      };
    case 'capability.not_connected': {
      const title = capability?.title ?? 'возможность';
      return {
        text: `Сейчас не подключено: ${title}. Подключение — в настройках профиля; агент это не обойдёт.`,
        evidenceRefs: [`connection_state:${capability?.integrationId ?? 'unknown'}`],
      };
    }
    case 'capability.missing_input': {
      const fields = capability?.requiredInputs ?? [];
      return {
        text: `Чтобы выполнить действие, нужен ваш ответ: ${fields.join(', ')}. Агент не запускаю — данных не хватает, а не движка.`,
        evidenceRefs: [`profile_fields:${fields.join(',')}`],
      };
    }
    default:
      return null;
  }
}

/** Заявка агенту (§11.5). Ничего не исполняет — только собирает контракт. */
export interface AgentWorkOrder {
  userTaskId: string;
  profileId: string;
  conversationId: string | null;
  /** Ссылка на неизменённый исходный запрос, а не переформулированная цель. */
  originalRequestRef: string;
  goal: string;
  preservedConstraints: string[];
  requiredCapabilities: string[];
  reasonCode: string;
  escalationReason: string;
  executor: 'opencode';
  authorizationRef: string;
  /** Есть ли в тексте запрет на внешнее действие — агент обязан его сохранить. */
  requiresConfirmation: boolean;
}

export function agentWorkOrder(params: {
  envelope: { userTaskId: string; profileId: string; conversationId: string | null; requestId: string | null };
  prepared: PreparedInput;
  reasonCode: string;
  requiresExternalAction: boolean;
  authorizationRef: string;
  catalogCapabilityIds: string[];
}): AgentWorkOrder {
  return {
    userTaskId: params.envelope.userTaskId,
    profileId: params.envelope.profileId,
    conversationId: params.envelope.conversationId,
    originalRequestRef: `task:${params.envelope.userTaskId}:request:${params.envelope.requestId ?? 'none'}`,
    goal: params.prepared.text,
    preservedConstraints: [],
    requiredCapabilities: params.catalogCapabilityIds,
    reasonCode: params.reasonCode,
    escalationReason: params.reasonCode,
    executor: 'opencode',
    authorizationRef: params.authorizationRef,
    requiresConfirmation: params.requiresExternalAction,
  };
}
