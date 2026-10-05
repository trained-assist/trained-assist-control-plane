/**
 * Контракты Task Router: route policy и высокоточные правила (P16, этап I05).
 *
 * Источники: TASK-ROUTER-AND-MCP.md §11 (fast-path v1) и §3 (union reply/
 * clarify/needs_executor), stories/FAST-REPLIES.md (маршруты и классы),
 * stories/PROBES.md PR-21/PR-23, корпус `eval/fast-replies/dialogs.v1.jsonl` (P18).
 *
 * Три вещи разведены намеренно и не смешиваются:
 *  1. ПРИЗНАКИ (features) — что видно в тексте/контексте. Признак не является
 *     решением: «в тексте есть ссылка» само по себе не значит «нужен агент»
 *     (PR-23), а «есть слово rate limit» не значит «аварийный путь» (PR-24).
 *  2. РЕШЕНИЕ (route + reasonCode) — чистая функция политики от признаков,
 *     проверенного каталога и снимка прав.
 *  3. ПРАВА (authorization) — только из идентичности/снимка, никогда из текста
 *     запроса (AC-126, инвариант «permissions не выводятся regex»).
 *
 * Лексика маршрутов — из stories/FAST-REPLIES.md: `deterministic`, `template`,
 * `llm`, `clarify`, `required_input`, `agent`. Это НЕ типы Job: `agent` —
 * разрешённый исполнитель OpenCode, `llm` — один ограниченный recipe-вызов
 * без инструментов.
 */

/** Версия политики маршрутизации: меняется при смене правил, не при правке текста. */
export const ROUTE_POLICY_VERSION = 'route-policy-v1-2026-10-04';

/** Единственный автоматический исполнитель эскалации (§ policy 30.09). */
export const TERMINAL_EXECUTOR = 'opencode' as const;
export type ExecutorName = typeof TERMINAL_EXECUTOR;

/** Маршруты корпуса быстрых ответов (stories/FAST-REPLIES.md, «Куда уходит реплика»). */
export const ROUTES = ['deterministic', 'template', 'llm', 'clarify', 'required_input', 'agent'] as const;
export type Route = (typeof ROUTES)[number];

/** Исполнитель решения. `none` — решение есть, исполнения нет (blocked/wait). */
export const ROUTE_MODES = [
  'deterministic-handler',
  'template-handler',
  'llm-recipe-job',
  'ai-agent-job',
  'none',
] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/** Причины перехода. Значение, не текст: по нему считаются метрики §11.9. */
export const REASON_CODES = [
  'COMMUNICATION_SELECTED',
  'COMMUNICATION_FALLBACK',
  // детерминированные пути (§11.2 шаг 1)
  'TYPED_COMMAND',
  'SERVICE_COMMAND',
  'STOP_REQUEST',
  'STATUS_LOOKUP',
  'AWAITING_ANSWER_CONTINUATION',
  // данные пользователя из снимка хоста
  'OWN_DATA_CAPABILITY',
  'TEMPLATE_CAPABILITY',
  'CAPABILITY_QUESTION',
  'CAPABILITY_NOT_CONNECTED',
  'MISSING_REQUIRED_INPUT',
  // быстрый ответ по данному тексту
  'TEXT_WORK_ON_GIVEN_CONTENT',
  'DIALOG_CONTINUATION',
  'CLOSING_NO_NEW_COLLECTION',
  'ACKNOWLEDGEMENT',
  'QUOTED_LINK_NOT_FETCHED',
  // эскалация
  'LIVE_DATA_NO_CAPABILITY',
  'EXTERNAL_EFFECT_NO_CAPABILITY',
  'ADAPTIVE_TOOL_LOOP',
  // причины эскалации, которые называет рецепт (§11.3): узкий allowlist
  'NEEDS_CURRENT_USER_DATA',
  'CONTEXT_NOT_COVERED',
  'ARTIFACT_WORKSPACE_REQUIRED',
  // уточнение
  'AMBIGUOUS_WITHOUT_CONTEXT',
  'AMBIGUOUS_URL_ONLY',
  // отказ по снимку/бюджету/праву — исполнитель не включается
  'BUDGET_EXHAUSTED',
  'BUDGET_DENIED',
  'PERMISSION_DENIED',
  'AGENT_NOT_ALLOWED_BY_POLICY',
  'CONTEXT_SNAPSHOT_MISSING',
  'CONTEXT_SNAPSHOT_STALE',
  'NO_ENABLED_CANDIDATES',
  'UNKNOWN_CAPABILITY_VERSION',
  // технические исходы recipe (§11.3): это НЕ маршрут в агента
  'MODEL_REFUSED',
  'MODEL_TIMEOUT',
  'SCHEMA_INVALID',
  'SCHEMA_TRUNCATED',
  'PROVIDER_FAILURE',
  'SEMANTIC_INVALID',
  'CONTEXT_NOT_SUFFICIENT',
  'CAPABILITY_HANDLER_ERROR',
  // покрытие входа
  'ATTACHMENT_EXTRACTION_PENDING',
  'MIDDLE_COVERAGE_MISSING',
  // brief builder (P20): технические исходы проекции каталога
  'BRIEF_BUDGET_EXCEEDED',
  'BRIEF_METADATA_INVALID',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Итог решения для журнала и метрик. `technical_error` не равен `reply`. */
export const OUTCOMES = [
  'reply',
  'clarify',
  'required_input',
  'blocked',
  'technical_error',
  'insufficient_context',
  'wait_extraction',
  'dispatched',
  'escalated',
  'noop',
] as const;
export type DecisionOutcome = (typeof OUTCOMES)[number];

export const SCHEMA_OUTCOMES = [
  'not_run',
  'valid',
  'invalid',
  'truncated',
  'timeout',
  'refused',
  'budget_denied',
  'provider_failure',
] as const;
export type SchemaOutcome = (typeof SCHEMA_OUTCOMES)[number];

export const SEMANTIC_OUTCOMES = ['not_run', 'valid', 'invalid', 'coverage_pending', 'invalid_missing_arg', 'not_evaluated'] as const;
export type SemanticOutcome = (typeof SEMANTIC_OUTCOMES)[number];

export const COVERAGES = ['full', 'attachment_pending', 'middle_missing', 'missing_snapshot', 'stale'] as const;
export type Coverage = (typeof COVERAGES)[number];

/**
 * Признаки текста/контекста. Ничего не решают: policy сопоставляет их с
 * проверенным каталогом. Ссылки и ключевые слова — признаки, а не маршрут.
 */
export interface UrlFeature {
  /** Хост без query/фрагмента: для решения достаточно, полный URL не нужен. */
  host: string;
  /** Ссылка находится внутри цитаты/вставленного текста — это данные, а не просьба. */
  quoted: boolean;
  /** Ссылка стоит рядом с глаголом чтения вне цитаты — просьба прочитать. */
  readIntentOutsideQuote: boolean;
}

/** Признаки намерения из текста пользователя (вне цитат). */
export interface TextFeatures {
  normalized: string;
  /** Ссылка есть, но просьбы её открыть вне цитаты нет (PR-23). */
  urls: UrlFeature[];
  /** Вставленный/процитированный текст: инструкции внутри него — данные. */
  quotedSpans: number;
  /** В цитате есть императивные инструкции — исполнить их нельзя. */
  embeddedInstruction: boolean;
  /** Глаголы чтения внешнего источника вне цитаты. */
  readIntent: boolean;
  /** Признак «данные сейчас/свежие» (курс, цена, что написано). */
  freshnessIntent: boolean;
  /** Внешнее действие (отправить, опубликовать, оплатить). */
  effectIntent: boolean;
  /** Самостоятельный выбор и итерация инструментов. */
  adaptiveIntent: boolean;
  /** Работа с текстом/данными, уже присутствующими в сообщении или диалоге. */
  textWorkIntent: boolean;
  /** Закрывающая реплика: «достаточно, собери итог» — новый сбор данных запрещён. */
  closingIntent: boolean;
  /** Короткая реплика подтверждения: «ок, спасибо». */
  acknowledgementIntent: boolean;
  /** Императив без объекта («сделай») — сам по себе не определяет задачу. */
  bareImperative: boolean;
}

export interface AttachmentFeature {
  artifactRef: string;
  kind: string;
  /** Извлечение завершено — содержимое можно использовать в ответе. */
  extracted: boolean;
  chars: number | null;
}

/** Релевантный контекст диалога (не полный дамп: только то, чем маршрут пользуется). */
export interface ConversationContext {
  /** Есть ли предложенное ранее действие, которое «сделай» продолжает. */
  pendingProposal: string | null;
  /** Последняя реплика ассистента, к которой относится продолжение. */
  lastAssistantText: string | null;
  /** Диалог пуст — уточнять нечего. */
  sessionEmpty: boolean;
  /** Число релевантных предыдущих реплик, переданных в контекст. */
  relevantTurns: number;
}

export interface PreparedInput {
  originalInput?: unknown;
  durableContext?: {
    history: Array<{ id: string; author: string; text: string }>;
    active_tasks: Array<{ id: string; goal: string; expected_answer?: string }>;
  };
  /** Полный текст текущего запроса (не head/tail: §11.6). */
  text: string;
  context: ConversationContext;
  attachments: AttachmentFeature[];
  /**
   * Нативный typed-сигнал шлюза: кнопка, команда или ответ на открытое
   * ожидание. Отличается от текстовой фразы пользователя (§12): маршрут
   * детерминирован и модель не вызывается.
   */
  typedSignal: { kind: 'button' | 'command' | 'awaiting_answer'; ref: string } | null;
  /** Версия собранного контекста: часть ключа кэша и проверки свежести. */
  contextVersion: string;
  /** Снимок готовности на момент запроса; без него counterfactual-оценка неполна (§11.8). */
  readinessSnapshotPresent: boolean;
}

/**
 * Доверенная оболочка (trusted envelope). Приходит от хоста; поля не может
 * менять ни текст запроса, ни модель (§11.1).
 */
export interface RoutingEnvelope {
  principalId: string;
  profileId: string;
  userTaskId: string;
  conversationId: string | null;
  catalogVersion: string;
  policyVersion: string;
  budgets: BudgetSnapshot;
  /** Попытка control plane, если маршрут выполняется в рамках задачи. */
  runId: string | null;
  requestId: string | null;
}

export interface BudgetSnapshot {
  /** Остаток платных вызовов модели. 0 → template/blocked ДО платного вызова (§11.2). */
  llmCallsRemaining: number;
  /** Разрешён ли запуск агента политикой для этого principal. */
  agentAllowed: boolean;
}

/**
 * Снимок прав. Источник — только идентичность (identity snapshot) и связывания,
 * которые хост прочитал до вызова recipe. `source` — машинно-проверяемое
 * утверждение: у снимка нет иного источника, текст запроса сюда не попадает.
 */
export interface AuthorizationSnapshot {
  principalId: string;
  profileId: string;
  grantedCapabilityIds: string[];
  grantedIntegrationIds: string[];
  /** Всегда 'identity_snapshot': право выводится из capability/identity. */
  source: 'identity_snapshot';
  /** Ссылка на снимок для лога: хэш (profile + capability + integration). */
  snapshotRef: string;
}

/** Режим возможности (P19/P20 supportedModes). Не тип Job. */
export type CapabilityMode = 'deterministic' | 'template' | 'llm' | 'agent';

export interface CapabilityEntry {
  id: string;
  version: number;
  title: string;
  /** Явные метки/алиасы каталога (P19/P20). Никаких regex по всему тексту. */
  aliases: string[];
  /** Откуда capability берёт данные: хост или внешний источник. */
  dataSource: 'task_store' | 'connection_state' | 'clock' | 'external_live' | 'none';
  /** Что делает: чтение или внешнее действие (write требует подтверждения). */
  effect: 'read' | 'write' | 'none';
  /** Интеграция, чьё подключение определяет готовность. */
  integrationId: string | null;
  /** Обязательные входы: их отсутствие → required_input, а не агент (§11.4). */
  requiredInputs: string[];
  /** Что маршрут делает при совпадении. */
  routeHint: 'deterministic' | 'template' | 'capability_dispatch';
  /** Поддерживаемые режимы (P19 supportedModes). */
  supportedModes: CapabilityMode[];
  /** Предпочтительный режим: обязан входить в supportedModes и иметь привязку. */
  preferredMode?: CapabilityMode;
  /** Явное читаемое имя маршрутизации (snake_case). Не переименование MCP. */
  routingName?: string;
  /** Нативное имя MCP-инструмента: brief его отображает, но не переименовывает. */
  nativeToolName?: string | null;
  /** Шаблонный ответ (для routeHint=template). */
  templateId: string | null;
  /** Привязка host-owned обработчика (deterministic-режим). */
  handlerRef?: string | null;
  /** Привязка фиксированного рецепта (llm-режим). */
  recipeId?: string | null;
  /** Полная input-схема: публикуется в Tier-2 только для кандидатов. */
  inputSchema?: BriefFieldSpec[];
  /** Полная output-схема: публикуется в Tier-2 только для кандидатов. */
  outputSchema?: BriefFieldSpec[];
  /** Ссылки на документацию и оригинальное определение. */
  docsRefs?: string[];
}

/** Поле схемы каталога (verified metadata, не вывод из названия). */
export interface BriefFieldSpec {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface CapabilityCatalog {
  version: string;
  capabilities: CapabilityEntry[];
}

/**
 * Факты профиля из хранилища хоста: подключения, контакты, часы. В песочнице
 * приходят из binding'а, в проде — из Profile Store (P14/P20).
 */
export interface HostFacts {
  clockMs: number;
  /** integrationId -> подключено ли у этого профиля. */
  connections: Record<string, boolean>;
  /** Обязательные входы, которые уже известны (email и т.п.). */
  profileFields: Record<string, string | null>;
  /** Активные задачи профиля (снимок task_store на момент запроса). */
  activeTasks: Array<{ id: string; state: string; title: string | null }>;
  /** Задачи за предыдущие сутки по часам профиля. */
  tasksYesterday: Array<{ id: string; title: string | null }>;
}

/** Решение политики: маршрут, причина, исполнитель и признаки, по которым выбрано. */
export interface RoutingDecision {
  policyVersion: string;
  decisionId: string;
  route: Route | null;
  mode: RouteMode;
  reasonCode: ReasonCode;
  capabilityId: string | null;
  capabilityVersion: number | null;
  /** Нужен ли агентский цикл (второй вопрос §1 — не «какая LLM подходит»). */
  needsExecutor: boolean;
  executor: ExecutorName | null;
  escalation: 'none' | 'agent';
  /** Ответ на внешний вопрос без данных в контексте запрещён. */
  replyAllowed: boolean;
  /**
   * ДЕГРАДАЦИЯ: маршрутизация не смогла решить по технической причине.
   *
   * Это НЕ «успешный быстрый ответ» и НЕ повод молча запустить дорогого агента.
   * Хост обязан показать видимый контролируемый исход: сообщение с причиной и
   * разрешённым действием (повторить / запустить вручную). Молчание здесь —
   * тот же класс дефекта, что «сообщение принято, но дальше тишина»
   * (arch#132, Приоритет 4).
   */
  degraded: boolean;
  /** Что хост должен показать при degraded. */
  degradedNotice: { text: string; actions: Array<'retry' | 'launch' | 'answer'> } | null;
  requiresFreshData: boolean;
  requiresExternalAction: boolean;
  /** Ссылки/ключевые слова как ПРИЗНАКИ: что именно совпало (без текста запроса). */
  evidence: DecisionEvidence;
  coverage: Coverage;
  schemaOutcome: SchemaOutcome;
  semanticOutcome: SemanticOutcome;
  modelCalls: number | null;
  /** Идентификатор рецепта, который принял решение (P17). */
  recipeId: string | null;
  /** Идентификатор модели без инструментов; null — модели не было. */
  modelId: string | null;
  /** Код отказа провайдера, если вызов не удался. */
  providerCode: string | null;
  usageSource: 'not_recorded' | 'measured';
  /** Попытка включить дорогого исполнителя по техническому исходу: всегда false. */
  escalationAttempt: boolean;
  firstUsefulReplyMs: number | null;
  outcome: DecisionOutcome;
  /** Поля для метрик корпуса (P18 harness). */
  continuationRef: string | null;
  jobRef: string | null;
  runRef: string | null;
  /** Сколько раз исполнялась capability в этой попытке (bounded termination §11.2). */
  capabilityExecutions: number;
  repairAttempts: number;
}

/** Что именно сработало. Только идентификаторы и счётчики — текста запроса здесь нет. */
export interface DecisionEvidence {
  typedCommand: string | null;
  matchedCapabilityId: string | null;
  matchedAlias: string | null;
  /** Ссылки: хосты и признак «в цитате», без полного URL. */
  urlHosts: string[];
  urlQuoted: boolean;
  urlReadIntent: boolean;
  /** Инструкция внутри цитаты не исполнялась (PR-23). */
  embeddedInstructionIgnored: boolean;
  /** Признаки намерения, по которым решение принято или отклонено. */
  intents: string[];
  /** Снимок прав, по которому фильтровались кандидаты. */
  permissionSource: 'identity_snapshot';
  authorizationRef: string;
  catalogVersion: string;
  contextVersion: string;
}

/** Полный вход политики: оболочка + подготовленный ввод + каталог + снимок прав. */
export interface RoutingInput {
  envelope: RoutingEnvelope;
  prepared: PreparedInput;
  catalog: CapabilityCatalog;
  authorization: AuthorizationSnapshot;
  hostFacts: HostFacts;
}

/** Валидатор каталога: снимок обязан быть проверенным, иначе решения нет (§11.2 шаг 4). */
export interface CatalogValidation {
  ok: boolean;
  errors: string[];
}
