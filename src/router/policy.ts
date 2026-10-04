/**
 * Route policy: чистая функция признаков → решение (P16, §11.2).
 *
 * Порядок правил — это и есть «высокоточные правила» карточки:
 *
 *   0. Технические предпосылки (снимок каталога, покрытие входа, бюджет).
 *      Отказ здесь НЕ превращается в запуск агента: по технической причине
 *      дорогой исполнитель не включается (§11.3, §11.7.7).
 *   1. Typed-сигналы и команды: кнопка/команда/ответ на ожидание.
 *   2. Точное совпадение служебной команды.
 *   3. Capability по данным пользователя (task_store/connection_state/clock):
 *      ответ целиком лежит в системе → код, без модели.
 *   4. Шаблонные ответы каталога и политики.
 *   5. Объявленная capability: не подключена → честный шаблон со шагом подключения,
 *      нет права → blocked, нет обязательного входа → required_input.
 *   6. Закрывающая реплика: новый сбор данных не запускается (U-14).
 *   7. Подтверждение: новая задача не создаётся.
 *   8. Внешнее действие без объявленной capability → исполнитель.
 *   9. Самостоятельный выбор итераций инструментов → исполнитель.
 *  10. Живые данные, которых нет в сообщении и нет capability → исполнитель.
 *  11. Уточнение/продолжение по контексту.
 *  12. Работа с уже данным текстом → один recipe-вызов без инструментов.
 *
 * Ссылки и ключевые слова — признаки (`intents` в evidence), а не маршрут.
 * Ссылка в цитате не открывается (PR-23), «rate limit» в обычном ответе не
 * уводит в аварийный путь (PR-24), а право не выводится из текста (AC-126):
 * кандидаты фильтруются снимком `authorization`, который рождается из
 * идентичности в `authorization.ts`.
 */
import { aliasMatchIn, exactAliasMatches, validateCatalog } from './catalog';
import { isCapabilityAllowed, isIntegrationAllowed } from './authorization';
import { aliasCoversRequest, coverageOf, extractTextFeatures } from './text-features';
import {
  ROUTE_POLICY_VERSION,
  TERMINAL_EXECUTOR,
  type CapabilityEntry,
  type Coverage,
  type DecisionEvidence,
  type DecisionOutcome,
  type PreparedInput,
  type ReasonCode,
  type Route,
  type RouteMode,
  type RoutingDecision,
  type RoutingInput,
  type TextFeatures,
} from './router-types';

/** Верхняя граница одной попытки решения (bounded termination §11.2 шаг 7). */
export const MAX_DECISION_ATTEMPTS = 1;

interface Draft {
  route: Route;
  mode: RouteMode;
  reasonCode: ReasonCode;
  capability: CapabilityEntry | null;
  /** Алиас каталога, по которому выбрана capability (для evidence). */
  matchedAlias: string | null;
  requiresFreshData: boolean;
  requiresExternalAction: boolean;
  needsExecutor: boolean;
  outcome: DecisionOutcome;
}

function evidenceOf(input: RoutingInput, features: TextFeatures, matched: CapabilityEntry | null, alias: string | null): DecisionEvidence {
  return {
    typedCommand: input.prepared.typedSignal?.ref ?? null,
    matchedCapabilityId: matched?.id ?? null,
    matchedAlias: alias,
    urlHosts: features.urls.map((u) => u.host),
    urlQuoted: features.urls.length > 0 && features.urls.every((u) => u.quoted),
    urlReadIntent: features.urls.some((u) => u.readIntentOutsideQuote),
    embeddedInstructionIgnored: features.embeddedInstruction,
    intents: intentsOf(features),
    permissionSource: input.authorization.source,
    authorizationRef: input.authorization.snapshotRef,
    catalogVersion: input.catalog.version,
    contextVersion: input.prepared.contextVersion,
  };
}

/** Какие признаки сработали. Список, а не флаг: по нему видно, почему решение. */
function intentsOf(features: TextFeatures): string[] {
  const out: string[] = [];
  if (features.readIntent) out.push('read_intent');
  if (features.freshnessIntent) out.push('freshness');
  if (features.effectIntent) out.push('external_effect');
  if (features.adaptiveIntent) out.push('adaptive_tools');
  if (features.textWorkIntent) out.push('text_work');
  if (features.closingIntent) out.push('closing');
  if (features.acknowledgementIntent) out.push('acknowledgement');
  if (features.bareImperative) out.push('bare_imperative');
  if (features.quotedSpans > 0) out.push('quoted_text');
  if (features.embeddedInstruction) out.push('embedded_instruction');
  if (features.urls.length > 0) out.push(features.urls.every((u) => u.quoted) ? 'url_quoted' : 'url_present');
  return out;
}

/** Данные уже даны в сообщении/вложении/контексте — «живых данных» тут не нужно. */
function dataGivenInInput(input: RoutingInput, features: TextFeatures): boolean {
  if (/\d/.test(features.normalized)) return true;
  if (features.quotedSpans > 0) return true;
  if (input.prepared.attachments.some((a) => a.extracted)) return true;
  return false;
}

function blocked(input: RoutingInput, reasonCode: ReasonCode, outcome: DecisionOutcome, coverage: Coverage): RoutingDecision {
  return {
    policyVersion: ROUTE_POLICY_VERSION,
    decisionId: '',
    route: outcome === 'blocked' ? 'template' : null,
    mode: outcome === 'blocked' ? 'template-handler' : 'none',
    reasonCode,
    capabilityId: null,
    capabilityVersion: null,
    needsExecutor: false,
    executor: null,
    escalation: 'none',
    replyAllowed: false,
    requiresFreshData: false,
    requiresExternalAction: false,
    evidence: {
      typedCommand: input.prepared.typedSignal?.ref ?? null,
      matchedCapabilityId: null,
      matchedAlias: null,
      urlHosts: [],
      urlQuoted: false,
      urlReadIntent: false,
      embeddedInstructionIgnored: false,
      intents: [],
      permissionSource: input.authorization.source,
      authorizationRef: input.authorization.snapshotRef,
      catalogVersion: input.catalog.version,
      contextVersion: input.prepared.contextVersion,
    },
    coverage,
    schemaOutcome: 'not_run',
    semanticOutcome: 'not_evaluated',
    modelCalls: 0,
    usageSource: 'measured',
    escalationAttempt: false,
    firstUsefulReplyMs: null,
    outcome,
    continuationRef: null,
    jobRef: null,
    runRef: input.envelope.runId,
    capabilityExecutions: 0,
    repairAttempts: 0,
  };
}

/**
 * Решение политики. Детерминированная функция: одинаковый вход — одинаковое
 * решение (нужно для воспроизводимого eval §11.7.5 и для сравнения версий).
 */
export function decideRoute(input: RoutingInput): RoutingDecision {
  const { prepared, hostFacts, envelope } = input;
  const features = extractTextFeatures(prepared.text);
  const { coverage } = coverageOf(prepared.attachments, prepared);

  // ── 0. Технические предпосылки: не отказ, а отсутствие основания решать ──
  if (input.catalog.capabilities.length === 0) {
    return withEvidence(blocked(input, 'NO_ENABLED_CANDIDATES', 'technical_error', coverage), features, null, null);
  }
  const catalogCheck = validateCatalog(input.catalog);
  if (!catalogCheck.ok) {
    return withEvidence(blocked(input, 'NO_ENABLED_CANDIDATES', 'technical_error', coverage), features, null, null);
  }
  if (!prepared.readinessSnapshotPresent) {
    return withEvidence(blocked(input, 'CONTEXT_SNAPSHOT_MISSING', 'technical_error', 'missing_snapshot'), features, null, null);
  }
  if (prepared.contextVersion.trim().length === 0) {
    return withEvidence(blocked(input, 'CONTEXT_SNAPSHOT_STALE', 'technical_error', 'stale'), features, null, null);
  }

  const draft = chooseDraft(input, features);
  return finalize(input, features, draft, coverage);
}

/** Шаги 1–12: выбор черновика решения по признакам и каталогу. */
function chooseDraft(input: RoutingInput, features: TextFeatures): Draft {
  const { prepared, hostFacts } = input;
  const normalized = features.normalized;
  const serviceEntries = input.catalog.capabilities.filter((c) => c.id.startsWith('service.'));
  const ownDataEntries = input.catalog.capabilities.filter(
    (c) => c.dataSource === 'task_store' || c.dataSource === 'connection_state' || c.dataSource === 'clock',
  );
  const templateEntries = input.catalog.capabilities.filter((c) => c.routeHint === 'template');
  const dispatchEntries = input.catalog.capabilities.filter((c) => c.routeHint === 'capability_dispatch');

  // ── 1. Typed-сигнал шлюза: нативная кнопка/ответ на ожидание ──
  const typed = prepared.typedSignal;
  if (typed) {
    const entry = input.catalog.capabilities.find((c) => c.aliases.some((a) => a.toLowerCase() === typed.ref.toLowerCase()));
    if (entry) return draftFor(entry, null, 'TYPED_COMMAND');
    if (typed.kind === 'awaiting_answer') {
      return { route: 'deterministic', mode: 'deterministic-handler', reasonCode: 'AWAITING_ANSWER_CONTINUATION', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
    }
    return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'TYPED_COMMAND', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
  }

  // ── 2. Служебная команда: точное совпадение, без regex по всему тексту ──
  for (const entry of serviceEntries) {
    const exact = exactAliasMatches(entry, normalized);
    if (exact) {
      if (entry.id === 'service.stop') {
        return { ...draftFor(entry, exact, 'STOP_REQUEST'), requiresExternalAction: true, outcome: 'dispatched' };
      }
      if (entry.id === 'service.status') {
        return { ...draftFor(entry, exact, 'STATUS_LOOKUP'), outcome: 'dispatched' };
      }
      return draftFor(entry, exact, 'SERVICE_COMMAND');
    }
  }

  // ── 3. Данные пользователя: ответ целиком из снимка хоста ──
  // Для данных пользователя блокирующим считается только ВНЕШНЕЕ чтение с
  // объектом/ссылкой: «подключён ли у меня гугл-диск» — вопрос о своём
  // подключении (свой снимок), а не просьба открыть чужую страницу.
  const urlRead = features.urls.some((u) => u.readIntentOutsideQuote);
  const externalCue = features.effectIntent || features.adaptiveIntent || urlRead;
  const ownDataMatch = bestMatch(ownDataEntries, normalized, externalCue);
  if (ownDataMatch) return draftFor(ownDataMatch.entry, ownDataMatch.alias, 'OWN_DATA_CAPABILITY');

  // ── 4. Шаблон каталога/политики ──
  const templateMatch = bestMatch(templateEntries, normalized, features.effectIntent);
  if (templateMatch) return draftFor(templateMatch.entry, templateMatch.alias, 'TEMPLATE_CAPABILITY');

  // ── 5. Объявленная capability ──
  const liveDataAsk = (features.freshnessIntent || urlRead) && !dataGivenInInput(input, features);
  const dispatchMatch = bestMatch(dispatchEntries, normalized, features.effectIntent || features.adaptiveIntent || liveDataAsk);
  if (dispatchMatch) {
    const entry = dispatchMatch.entry;
    const integrationId = entry.integrationId;
    const connected = integrationId !== null ? hostFacts.connections[integrationId] === true : true;
    if (!isIntegrationAllowed(input.authorization, integrationId) || !isCapabilityAllowed(input.authorization, entry.id)) {
      return { ...draftFor(entry, dispatchMatch.alias, 'PERMISSION_DENIED'), route: 'template', mode: 'template-handler', outcome: 'blocked' };
    }
    if (!connected) {
      // Неподключённая возможность — честный шаблон со шагом подключения.
      // Агент здесь означал бы «обойдём отсутствие интеграции» (§11.4).
      return { route: 'template', mode: 'template-handler', reasonCode: 'CAPABILITY_NOT_CONNECTED', capability: entry, matchedAlias: dispatchMatch.alias, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
    }
    const missing = entry.requiredInputs.filter((field) => {
      const value = hostFacts.profileFields[field];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      return { route: 'required_input', mode: 'template-handler', reasonCode: 'MISSING_REQUIRED_INPUT', capability: entry, matchedAlias: dispatchMatch.alias, requiresFreshData: false, requiresExternalAction: entry.effect === 'write', needsExecutor: false, outcome: 'required_input' };
    }
    return draftFor(entry, dispatchMatch.alias, 'CAPABILITY_QUESTION');
  }

  // ── 6. Закрывающая реплика: новый сбор данных не запускается (U-14) ──
  if (features.closingIntent) {
    return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'CLOSING_NO_NEW_COLLECTION', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
  }

  // ── 7. Подтверждение: новая задача не создаётся ──
  if (features.acknowledgementIntent) {
    return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'ACKNOWLEDGEMENT', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
  }

  // ── 8. Внешнее действие без объявленной capability → исполнитель ──
  if (features.effectIntent) {
    return { route: 'agent', mode: 'ai-agent-job', reasonCode: 'EXTERNAL_EFFECT_NO_CAPABILITY', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: true, needsExecutor: true, outcome: 'escalated' };
  }

  // ── 9. Самостоятельный выбор и итерации инструментов → исполнитель ──
  if (features.adaptiveIntent) {
    return { route: 'agent', mode: 'ai-agent-job', reasonCode: 'ADAPTIVE_TOOL_LOOP', capability: null, matchedAlias: null, requiresFreshData: true, requiresExternalAction: false, needsExecutor: true, outcome: 'escalated' };
  }

  // ── 10. Живые данные: нужен исполнитель, если данных нет в сообщении ──
  const liveDataNeeded = (features.freshnessIntent || urlRead) && !dataGivenInInput(input, features);
  if (liveDataNeeded) {
    return { route: 'agent', mode: 'ai-agent-job', reasonCode: 'LIVE_DATA_NO_CAPABILITY', capability: null, matchedAlias: null, requiresFreshData: true, requiresExternalAction: false, needsExecutor: true, outcome: 'escalated' };
  }

  // ── 11. Уточнение или продолжение ──
  if (features.bareImperative) {
    if (prepared.context.pendingProposal) {
      return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'DIALOG_CONTINUATION', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
    }
    return { route: 'clarify', mode: 'none', reasonCode: 'AMBIGUOUS_WITHOUT_CONTEXT', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'clarify' };
  }
  if (features.urls.length > 0 && !features.textWorkIntent && features.urls.every((u) => u.quoted)) {
    // Ссылка упомянута, но просьбы её открыть нет: обсуждаем текст, страницу не читаем.
    return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'QUOTED_LINK_NOT_FETCHED', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
  }
  if (features.urls.length > 0 && features.normalized.length <= 40 && !features.readIntent && !features.textWorkIntent) {
    return { route: 'clarify', mode: 'none', reasonCode: 'AMBIGUOUS_URL_ONLY', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'clarify' };
  }
  if (prepared.context.relevantTurns > 0 && !features.textWorkIntent) {
    return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'DIALOG_CONTINUATION', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
  }

  // ── 12. Работа с уже данным текстом: один recipe-вызов, без инструментов ──
  // Данные уже в сообщении/вложении/контексте — «живые» не нужны, но это и не
  // детерминированный путь: работа по смыслу, одна модель без инструментов.
  if (features.textWorkIntent || features.quotedSpans > 0 || dataGivenInInput(input, features)) {
    return { route: 'llm', mode: 'llm-recipe-job', reasonCode: 'TEXT_WORK_ON_GIVEN_CONTENT', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'reply' };
  }

  return { route: 'clarify', mode: 'none', reasonCode: 'AMBIGUOUS_WITHOUT_CONTEXT', capability: null, matchedAlias: null, requiresFreshData: false, requiresExternalAction: false, needsExecutor: false, outcome: 'clarify' };
}

/** Capability → черновик решения по её объявленному маршруту. */
function draftFor(entry: CapabilityEntry, alias: string | null, reasonCode: ReasonCode): Draft {
  const base = {
    capability: entry,
    matchedAlias: alias,
    requiresFreshData: entry.dataSource === 'external_live',
    requiresExternalAction: entry.effect === 'write',
    needsExecutor: false,
  };
  if (entry.routeHint === 'template') {
    return { route: 'template', mode: 'template-handler', reasonCode, outcome: 'reply', ...base };
  }
  if (entry.routeHint === 'capability_dispatch' || entry.routeHint === 'deterministic') {
    const needsRecipe = !entry.supportedModes.includes('deterministic');
    return {
      route: needsRecipe ? 'llm' : 'deterministic',
      mode: needsRecipe ? 'llm-recipe-job' : 'deterministic-handler',
      reasonCode,
      outcome: 'dispatched',
      ...base,
    };
  }
  return { route: 'deterministic', mode: 'deterministic-handler', reasonCode, outcome: 'dispatched', ...base };
}

interface AliasMatch {
  entry: CapabilityEntry;
  alias: string;
  length: number;
}

/**
 * Самое специфичное совпадение алиаса. `blockedByIntent` отсекает совпадение,
 * когда в тексте есть более сильный признак (внешнее чтение/действие/адаптив):
 * «подключён ли у меня гугл-диск, и заодно открой их сайт» — это не только
 * вопрос о подключении.
 */
function bestMatch(entries: CapabilityEntry[], normalized: string, blockedByIntent: boolean): AliasMatch | null {
  if (blockedByIntent) return null;
  const matches: AliasMatch[] = [];
  for (const entry of entries) {
    const hit = aliasMatchIn(entry, normalized);
    // Алиас должен покрывать весь запрос, иначе детерминированный путь
    // молча выбросит вторую просьбу (пропуск действия = false-fast).
    if (hit && aliasCoversRequest(normalized, entry.aliases)) matches.push({ entry, alias: hit.alias, length: hit.length });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.length - a.length);
  const top = matches[0] as AliasMatch;
  const runnerUp = matches[1];
  // Равная специфичность у разных capability = неоднозначность, а не выбор.
  if (runnerUp && runnerUp.length === top.length && runnerUp.entry.id !== top.entry.id) return null;
  return top;
}

/** Финализация: бюджет, право на исполнителя, покрытие, семантика решения. */
function finalize(input: RoutingInput, features: TextFeatures, draft: Draft, coverage: Coverage): RoutingDecision {
  const budget = input.envelope.budgets;
  let effective = draft;
  let schemaOutcome: RoutingDecision['schemaOutcome'] = 'not_run';
  let semanticOutcome: RoutingDecision['semanticOutcome'] = 'valid';
  let modelCalls: number | null = 0;
  let outcome = draft.outcome;
  let replyAllowed = draft.route !== 'agent' && draft.outcome !== 'blocked' && draft.outcome !== 'clarify' && draft.outcome !== 'required_input';

  // Бюджет проверяется ДО платного вызова; дешёвые детерминированные пути
  // остаются доступны (FR-063: лимит исчерпан → честная причина, не тихий
  // переход на дорогую модель).
  if (draft.route === 'llm' && budget.llmCallsRemaining <= 0) {
    effective = { ...draft, route: 'template', mode: 'template-handler', reasonCode: 'BUDGET_EXHAUSTED', outcome: 'blocked' };
    schemaOutcome = 'budget_denied';
    replyAllowed = false;
    outcome = 'blocked';
  }
  if (draft.route === 'agent' && !budget.agentAllowed) {
    effective = { ...draft, route: 'template', mode: 'template-handler', reasonCode: 'AGENT_NOT_ALLOWED_BY_POLICY', needsExecutor: false, outcome: 'blocked' };
    replyAllowed = false;
    outcome = 'blocked';
  }

  // Покрытие входа: неполное покрытие не даёт опубликовать содержательный ответ.
  if (replyAllowed && coverage === 'attachment_pending') {
    semanticOutcome = 'coverage_pending';
    outcome = 'wait_extraction';
    replyAllowed = false;
    modelCalls = 0;
  } else if (replyAllowed && coverage === 'middle_missing') {
    semanticOutcome = 'coverage_pending';
    outcome = 'blocked';
    replyAllowed = false;
    modelCalls = 0;
  } else if (replyAllowed && effective.route === 'llm') {
    // Один полезный вызов recipe на решение; repair максимум один (§11.2).
    schemaOutcome = 'valid';
    modelCalls = 1;
  }

  const needsExecutor = effective.route === 'agent' && outcome !== 'blocked';
  return withEvidence(
    {
      policyVersion: ROUTE_POLICY_VERSION,
      decisionId: '',
      route: effective.route,
      mode: needsExecutor ? 'ai-agent-job' : effective.mode,
      reasonCode: effective.reasonCode,
      capabilityId: effective.capability?.id ?? null,
      capabilityVersion: effective.capability?.version ?? null,
      needsExecutor,
      executor: needsExecutor ? TERMINAL_EXECUTOR : null,
      escalation: needsExecutor ? 'agent' : 'none',
      replyAllowed,
      requiresFreshData: effective.requiresFreshData,
      requiresExternalAction: effective.requiresExternalAction,
      evidence: evidenceOf(input, features, effective.capability, effective.matchedAlias),
      coverage,
      schemaOutcome,
      semanticOutcome,
      modelCalls,
      usageSource: 'measured',
      // Технический исход не включает исполнителя: попытка эскалации по сбою
      // модели/схемы/бюджета запрещена (§11.3), и лог это фиксирует явно.
      escalationAttempt: false,
      firstUsefulReplyMs: null,
      outcome,
      continuationRef: null,
      jobRef: null,
      runRef: input.envelope.runId,
      capabilityExecutions: 0,
      repairAttempts: 0,
    },
    features,
    effective.capability,
    effective.matchedAlias,
  );
}

function withEvidence(
  decision: RoutingDecision,
  features: TextFeatures,
  capability: CapabilityEntry | null,
  alias: string | null,
): RoutingDecision {
  decision.evidence.intents = intentsOf(features);
  decision.evidence.matchedCapabilityId = capability?.id ?? decision.evidence.matchedCapabilityId;
  decision.evidence.urlHosts = features.urls.map((u) => u.host);
  decision.evidence.urlQuoted = features.urls.length > 0 && features.urls.every((u) => u.quoted);
  decision.evidence.urlReadIntent = features.urls.some((u) => u.readIntentOutsideQuote);
  decision.evidence.embeddedInstructionIgnored = features.embeddedInstruction;
  if (alias) decision.evidence.matchedAlias = alias;
  return decision;
}
