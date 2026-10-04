/**
 * Фиксированная модель без инструментов (P17; §5, §11.2 шаг 3).
 *
 * Порт намеренно не имеет ни одного поля про инструменты: у рецепта нет tools,
 * нет автономного filesystem и нет цикла произвольных вызовов. Это свойство
 * типа (`exposesTools: false`), а не флаг в рантайме: добавить инструменты в
 * запрос нельзя без правки этого файла, а проверка в тестах и в песочнице
 * убеждается, что в запросе нет ключа `tools`.
 *
 * Исходы провайдера типизированы и НЕ превращаются в ответ пользователю:
 * timeout, provider_failure, budget_denied, refused и truncated — отдельные
 * технические исходы (§11.3), по которым исполнитель не включается.
 */
import type { Coverage } from '../router-types';
import { DECISION_SCHEMA_VERSION, RECIPE_ID, type DecisionKind } from './decision-contract';
import type { PreparedCapabilityData } from './host-data';

/** Схема решения, которую провайдер получает как контракт (не как подсказку). */
export type FixedModelSchema = Record<string, unknown>;

export interface FixedModelPayload {
  /** Полный текст текущего запроса (§11.6: не head/tail). */
  request: string;
  conversation: {
    relevantTurns: number;
    pendingProposal: string | null;
    lastAssistantText: string | null;
  };
  /** Компактный снимок каталога: только разрешённые и готовые возможности. */
  catalogBrief: {
    version: string;
    capabilities: Array<{
      id: string;
      version: number;
      title: string;
      supportedModes: string[];
      requiredInputs: string[];
      integrationId: string | null;
      ready: boolean;
    }>;
  };
  coverage: Coverage;
  /** Данные, подготовленные ХОСТОМ (handler'ом), а не добытые моделью. */
  preparedData: PreparedCapabilityData | null;
  /** Что покрыто, а что нет: модель видит границы контекста явно. */
  coverageFlags: string[];
}

export interface FixedModelRequest {
  decisionId: string;
  recipeId: string;
  schemaVersion: number;
  schema: FixedModelSchema;
  /** Системная часть фиксирована и не содержит текста пользователя. */
  systemPrompt: string;
  payload: FixedModelPayload;
  /** Дедлайн одного вызова: превышение — технический исход, не бесконечное ожидание. */
  deadlineMs: number;
  maxOutputTokens: number;
  /** Ремонт схемы: максимум один на решение (§11.2 шаг 7). */
  repair?: { reason: string; previousText: string };
}

export type FixedModelFinish = 'stop' | 'length' | 'refusal' | 'content_filter';

export type FixedModelResponse =
  | {
      kind: 'ok';
      text: string;
      finish: FixedModelFinish;
      usage: { inputTokens: number | null; outputTokens: number | null };
    }
  | { kind: 'timeout' }
  | { kind: 'provider_failure'; code: 'rate_limited' | 'server_error' | 'unavailable' | 'auth'; detail: string | null }
  | { kind: 'budget_denied'; code: 'no_budget' };

/**
 * Порт фиксированной модели. `exposesTools: false` — литеральная ложь: у
 * рецепта нет инструментов, и это видно в типе, а не в комментарии.
 */
export interface FixedModelPort {
  readonly modelId: string;
  readonly exposesTools: false;
  invoke(request: FixedModelRequest): Promise<FixedModelResponse>;
}

/** Системная часть промпта: фиксирована, текст пользователя сюда не попадает. */
export const RECIPE_SYSTEM_PROMPT = [
  'Ты — фиксированный рецепт быстрого ответа ассистента. Инструментов у тебя нет: ни поиска,',
  'ни файловой системы, ни отправки сообщений. Отвечай только тем, что дано в запросе,',
  'в контексте диалога и в снимке возможностей.',
  '',
  'Верни РОВНО ОДНО решение в формате JSON по схеме решения:',
  '- reply: готовый ответ пользователю (assessment.contextSufficient обязан быть true);',
  '- clarify: один короткий вопрос, без которого задачу не понять;',
  '- needs_executor: работа, которую нельзя сделать без инструментов или живых данных.',
  '',
  'Правила:',
  '- не выдумывай данные: числа, цены, статусы и содержимое страниц берутся только из снимка;',
  '- не называй исполнителя, идентификаторы задачи, права и бюджет — их назначает хост;',
  '- не выдумывай capability: выбирай только существующие в снимке id и версию;',
  '- если контекста недостаточно для содержательного ответа — не отвечай, а верни needs_executor или clarify.',
].join('\n');

/** Сколько вызовов модели разрешено на одно решение (§11.2 шаг 7). */
export const MAX_RECIPE_CALLS = 2;

/**
 * Скриптованная модель песочницы и тестов. Никакого сетевого вызова: решения
 * задаются сценарием, а сбой — управляемым флагом. Это проверка оркестрации,
 * а не качества живой модели (§11.7.5/§11.7.6).
 *
 * Каждый вызов записывается в `calls`: по видно, сколько раз модель звалась и
 * что именно ей пришло (в том числе — что инструментов не было).
 */
export interface ScriptedModelCall {
  index: number;
  decisionId: string;
  toolsPresent: boolean;
  repair: boolean;
  payloadChars: number;
  deadlineMs: number;
}

export type SandboxModelFault =
  | 'none'
  | 'refused'
  | 'timeout'
  | 'invalid_json'
  | 'truncated'
  | 'provider_failure'
  | 'budget_denied'
  | 'semantic_invalid'
  | 'needs_executor'
  | 'clarify'
  | 'awaiting_input'
  | 'insufficient_context';

export interface ScriptedFixedModelOptions {
  /** Сценарий решений: по одному на вызов; последний повторяется, если вызовов больше. */
  script?: string[];
  fault?: SandboxModelFault;
  /** Модель «медленнее» дедлайна: проверка границы времени. */
  delayMs?: number;
}

export function scriptedFixedModel(options: ScriptedFixedModelOptions = {}): FixedModelPort & {
  calls: ScriptedModelCall[];
} {
  const script = options.script ?? [];
  const fault = options.fault ?? 'none';
  const delayMs = options.delayMs ?? 0;
  const calls: ScriptedModelCall[] = [];
  let index = 0;

  return {
    modelId: 'sandbox-scripted-fixed-model',
    exposesTools: false,
    calls,
    async invoke(request) {
      const call: ScriptedModelCall = {
        index,
        decisionId: request.decisionId,
        toolsPresent: 'tools' in request,
        repair: request.repair !== undefined,
        payloadChars: request.payload.request.length,
        deadlineMs: request.deadlineMs,
      };
      calls.push(call);
      index += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (fault === 'timeout') return { kind: 'timeout' };
      if (fault === 'provider_failure') return { kind: 'provider_failure', code: 'server_error', detail: 'sandbox provider failure' };
      if (fault === 'budget_denied') return { kind: 'budget_denied', code: 'no_budget' };
      if (fault === 'refused') return { kind: 'ok', text: 'Извините, я не могу выполнить эту просьбу.', finish: 'refusal', usage: { inputTokens: null, outputTokens: null } };
      if (fault === 'truncated') return { kind: 'ok', text: '{"schemaVersion":1,"kind":"reply","reply":{"text":"Ответ обрезан', finish: 'length', usage: { inputTokens: null, outputTokens: null } };
      if (fault === 'invalid_json') return { kind: 'ok', text: 'это не JSON вовсе', finish: 'stop', usage: { inputTokens: null, outputTokens: null } };
      // Остальные режимы — не сбои, а заданные решения модели: песочница должна
      // уметь показать каждый исход рецепта (AC-128), поэтому clarify, ожидание
      // ввода, недостаточный контекст, эскалация и семантически невалидный ответ
      // воспроизводятся тем же портом, а не отдельным вызовом.
      if (fault === 'clarify') return sandboxOk(scriptedClarify('Что именно сделать?', ['goal']));
      if (fault === 'awaiting_input') return sandboxOk(scriptedClarify('Нужен ваш email, чтобы отправить файл.', ['email']));
      if (fault === 'insufficient_context') return sandboxOk(scriptedInsufficientContext());
      if (fault === 'needs_executor') {
        return sandboxOk(
          scriptedAgentDecision({
            nextGoal: 'найди пять конкурентов и сравни цены',
            reasonCode: 'ADAPTIVE_TOOL_LOOP',
            requiredCapabilities: ['web-search'],
          }),
        );
      }
      if (fault === 'semantic_invalid') return sandboxOk(scriptedUngroundedReply());
      const text = script.length > 0 ? script[Math.min(call.index, script.length - 1)]! : defaultReplyText(request);
      return sandboxOk(text);
    },
  };
}

function sandboxOk(text: string): { kind: 'ok'; text: string; finish: 'stop'; usage: { inputTokens: null; outputTokens: null } } {
  return { kind: 'ok', text, finish: 'stop', usage: { inputTokens: null, outputTokens: null } };
}

/** Ответ заглушки без модели: эхо по тексту запроса, без выдуманных данных. */
export function defaultReplyText(request: FixedModelRequest): string {
  const text = request.payload.request;
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'reply',
    reply: {
      text: `[песочница: recipe-заглушка без модели] Черновик по вашему тексту (${text.length} симв.): «${text.slice(0, 120)}»`,
      evidenceRefs: [],
    },
    assessment: { contextSufficient: true, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
  });
}

/** Решение по умолчанию для сценария «модель отвечает готовым reply». */
export function scriptedReply(text: string, refs: string[] = []): string {
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'reply',
    reply: { text, evidenceRefs: refs },
    assessment: { contextSufficient: true, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
  });
}

/** Ответ, который сам признаёт нехватку контекста: публиковать его нельзя. */
export function scriptedInsufficientContext(
  text = 'Ответ по неполному контексту',
): string {
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'reply',
    reply: { text, evidenceRefs: [] },
    assessment: { contextSufficient: false, needsFreshData: true, needsActions: false, needsAdaptiveTools: false },
  });
}

/** Ответ, ссылающийся на недопустимый источник: семантически невалидное решение. */
export function scriptedUngroundedReply(text = 'Ответ со ссылкой не оттуда'): string {
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'reply',
    reply: { text, evidenceRefs: ['куда-нибудь'] },
    assessment: { contextSufficient: true, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
  });
}

export function scriptedClarify(question: string, missingFields: string[]): string {
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'clarify',
    clarify: { question, missingFields },
    assessment: { contextSufficient: false, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
  });
}

export function scriptedAgentDecision(params: {
  nextGoal: string;
  reasonCode: 'ADAPTIVE_TOOL_LOOP' | 'CONTEXT_NOT_COVERED' | 'ARTIFACT_WORKSPACE_REQUIRED' | 'NEEDS_CURRENT_USER_DATA';
  preservedConstraints?: string[];
  requiredCapabilities?: string[];
}): string {
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'needs_executor',
    proposedJobType: 'ai-agent-job',
    nextGoal: params.nextGoal,
    preservedConstraints: params.preservedConstraints ?? [],
    requiredCapabilities: params.requiredCapabilities ?? [],
    reasonCode: params.reasonCode,
    assessment: { contextSufficient: false, needsFreshData: true, needsActions: false, needsAdaptiveTools: true },
  });
}

export function scriptedCapabilityDecision(params: {
  capabilityId: string;
  capabilityVersion: number;
  proposedJobType: 'deterministic-job' | 'llm-recipe-job';
  reasonCode: 'ADAPTIVE_TOOL_LOOP' | 'CONTEXT_NOT_COVERED' | 'ARTIFACT_WORKSPACE_REQUIRED' | 'NEEDS_CURRENT_USER_DATA';
  arguments?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind: 'needs_executor',
    proposedJobType: params.proposedJobType,
    capabilityId: params.capabilityId,
    capabilityVersion: params.capabilityVersion,
    arguments: params.arguments ?? {},
    reasonCode: params.reasonCode,
    assessment: { contextSufficient: true, needsFreshData: true, needsActions: false, needsAdaptiveTools: false },
  });
}
