import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { FencedError, TaskNotFoundError, TaskStore, TerminalStateError } from './taskstore';
import type { AdmissionScope, AwaitingKind, AwaitingPurpose, TaskRow } from './taskstore';
import { authorizeIntake, resolvePrincipal, requirePermission } from './intake/authorization';
import { toC02Event } from './events';
import {
  CfWorkflowPort,
  cfStepCtx,
  conversationPlan,
  deliverOnce,
  type DeliveryAdapter,
  type PlanOutcome,
  type PlanParams,
  type SubmitInput,
} from './workflow-port';
import { IntakeService, resolveDeliveryAdapter, runStuckInputSweep } from './intake';

/**
 * Насколько устаревшей должна быть отметка планировщика, чтобы это стало инцидентом.
 * Триггер идёт раз в минуту; 30 минут без отметки = планировщик умер молча.
 */
const WATCHDOG_STALE_MS = 30 * 60_000;
import { logStructured } from './logging/structured-log';
import { EnvelopeConflictError, PrincipalForbiddenError, PrincipalUnauthorizedError } from './intake/errors';
import { AnswerConflictError, AnswerRejectedError } from './taskstore/errors';
import type { CredentialReadyEvent, CredentialRequirement } from './awaiting/credential-ready';
import { runnerAdapterOf } from './runner-adapter';
import { RunnerNotFoundError, RunnerUnavailableError } from './runner-adapter/errors';
import { runSpecPolicyOf } from './run-spec/run-spec';
import { ProfileRuntimeConfigurationError, resolveProfileRuntime } from './run-spec/profile-runtime';
import { runnerExternalStopPort } from './workflow-port/external-stop';
import { principalAuthOf, verifyPrincipal, type PrincipalAuth } from './auth/principal-auth';
import { InvalidEnvelopeError } from './intake/envelope';
import { PilotRouter } from './pilot';
import { reportSnapshot, reportHistory, reportView } from './reporting';
import { ScheduleService, ScheduleStore, VirtualClock, portSubmitter, systemClock, type Clock } from './schedule';
import {
  GtdError,
  GtdService,
  GtdStore,
  GtdUnknownRecordError,
  type GtdStepOutcome,
  type ManagedGtdContext,
} from './gtd';
import {
  deriveAuthorization,
  routeRequest,
  sandboxCapabilityCatalog,
} from './router';
import { createReplyOrRouteRunner } from './router/recipe/recipe';
import { sandboxHostCapabilityHandler } from './router/recipe/host-data';
import { scriptedFixedModel, type SandboxModelFault } from './router/recipe/fixed-model';
import { ScopedBriefCache } from './router/brief/cache';
import { briefBuildSummaryOf } from './router/brief/service';
import { DEFAULT_BRIEF_MAX_BYTES, DEFAULT_BRIEF_MAX_CANDIDATES } from './router/brief/compiler';
import { communicationSelector, communicationWriter } from './router/communication-client';
import { communicationV1Catalog, durableConversationContext, probeRunnerHealth } from './router/communication-v1';
import { commitQuickAnswer, dispatchAcceptedAgent } from './output/communication-v1';
import type { RouteResult } from './router/service';
import {
  continueFastPathEscalation,
  portContinuationPort,
  taskStoreContinuationStore,
  CONTINUATION_EVENT,
} from './output';

export interface Env {
  NATIVE_CANCEL_CONFIRMATION?: string;
  ROUTER_SELECTOR_NAMES_ONLY?: string;
  ROUTER_SELECTOR?: string;
  COMMUNICATION_API_URL?: string;
  COMMUNICATION_SERVICE?: Fetcher;
  COMMUNICATION_TOKEN?: string;
  COMMUNICATION_TIMEOUT_MS?: string;
  COMMUNICATION_WRITER_TIMEOUT_MS?: string;
  ROUTER_AGENT_ENGINE?: string;
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
  /**
   * 'true' — изолированный preview: scheduled-обработчики не выполняются.
   * Держать тем же флагом, что и в tg-bot, чтобы previews не слали алерты.
   */
  PREVIEW_ONLY?: string;
  /**
   * Доставка: 'local' — песочничная заглушка (искусственный providerMessageId,
   * доставкой НЕ является), 'gateway' — реальный адаптер канала (arch#132 П3b).
   */
  DELIVERY_ADAPTER?: string;
  /** URL шлюза для реального адаптера доставки, если DELIVERY_ADAPTER='gateway'. */
  GATEWAY_DELIVERY_URL?: string;
  /** Секрет шлюза для реального адаптера доставки. */
  GATEWAY_DELIVERY_SECRET?: string;
  /** Serverless Agent API (ai-agent-runner). Только из env, в репозитории нет. */
  RUNNER_API_URL?: string;
  RUNNER_API_KEY?: string;
  RUNNER_API_KEY_TELEGRAM_UX?: string;
  RUN_SPEC_PROFILE_OVERRIDES?: string;
  RUN_SPEC_POLICY_PROFILE?: string;
  RUN_SPEC_REPOSITORY?: string;
  RUN_SPEC_INPUT_REFS?: string;
  RUN_SPEC_CWD?: string;
  RUN_SPEC_ENV_ALLOWLIST?: string;
  RUN_SPEC_OUTPUTS?: string;
  RUN_SPEC_MCP?: string;
  RUN_SPEC_RESULT_DESTINATION_REF?: string;
  RUN_SPEC_TIMEOUT_MS?: string;
  RUN_SPEC_STARTUP_TIMEOUT_MS?: string;
  RUN_SPEC_MAX_OUTPUT_BYTES?: string;
  RUN_SPEC_MAX_LOG_BYTES?: string;
  /**
   * Секрет проверки личности принципала (HMAC). Только из binding
   * (GCP SM / GitHub Secrets). Без него доступ к API закрыт полностью.
   */
  PRINCIPAL_SECRET?: string;
  CREDENTIAL_HOST_PRINCIPALS?: string;
  /**
   * Фиксированный «сейчас» расписания (epoch ms) — только для песочницы I07 на
   * виртуальных часах. В проде не задаётся: время берёт системный clock.
   */
  SCHEDULE_CLOCK?: string;
  /**
   * Task Router (P16, этап I05). Песочница I05; в проде эти поля заполняет
   * компилятор каталога и credential broker (P19/P20), поэтому здесь всё
   * приходит из bindings, а не из кода клиента.
   */
  /** { principalId: { capabilities: [...], integrations: [...] } } — выдача прав. */
  ROUTER_GRANTS?: string;
  /** { connections: {...}, profileFields: {...} } — снимок профиля на момент запроса. */
  ROUTER_PROFILE_FACTS?: string;
  /** Фиксированные часы роутера (epoch ms) — воспроизводимый прогон песочницы. */
  ROUTER_CLOCK?: string;
  /** Остаток платных вызовов модели в песочнице (по умолчанию 1). */
  ROUTER_LLM_BUDGET?: string;
  /** 'false' — исполнитель запрещён политикой песочницы (проверка blocked). */
  ROUTER_AGENT_ALLOWED?: string;
  /**
   * Рецепт P17. По умолчанию — скриптованная модель песочницы (без сети и без
   * ключа): проверяются контракт решения, границы и исходы, а не качество живой
   * модели (§11.7.5/§11.7.6). Живой провайдер подключается отдельно.
   */
  ROUTER_RECIPE_STUB?: string;
  /**
   * Управляемый сбой рецепта: refused | timeout | invalid_json | truncated |
   * provider_failure | budget_denied | semantic_invalid | needs_executor |
   * clarify | awaiting_input | insufficient_context.
   */
  ROUTER_RECIPE_FAULT?: string;
  /** Сценарий решений скриптованной модели (JSON-массив строк). */
  ROUTER_RECIPE_SCRIPT?: string;
  /** Дедлайн одного вызова модели в миллисекундах. */
  ROUTER_RECIPE_DEADLINE_MS?: string;
  /** 'true' — разрешить выдачу продолжения (новый job/run) на POST /route. */
  ROUTER_CONTINUATION_ENABLED?: string;
  /**
   * Brief builder (P20, этап I06). Проекция проверенного каталога для рецепта и
   * исполнителя: Tier-1 для всех разрешённых, Tier-2 только для кандидатов.
   * Размер измеряется в байтах и укладывается в бюджет; кэш ключуется по области
   * (profile/права/связывания/каталог/политика/контекст).
   */
  /** Бюджет размера brief'а в байтах (по умолчанию 24576). */
  ROUTER_BRIEF_MAX_BYTES?: string;
  /** Максимум кандидатов с Tier-2 (по умолчанию 12). */
  ROUTER_BRIEF_MAX_CANDIDATES?: string;
  /** Максимум записей в кэше brief'а (по умолчанию 64). */
  ROUTER_BRIEF_CACHE_MAX_ENTRIES?: string;
}

const isPermanent = (e: unknown): boolean =>
  e instanceof ProfileRuntimeConfigurationError ||
  e instanceof FencedError ||
  e instanceof TerminalStateError ||
  /fenced|terminal state/i.test(String((e as Error)?.message ?? e));

/**
 * Кэш brief'а (P20): один экземпляр на изолят, поэтому повторные запросы той
 * же области не пересобирают проекцию каталога. Ключ кэша включает профиль,
 * права, связывания, версии каталога/политики и контекст — чужая область не
 * получает чужой brief.
 */
let briefCacheInstance: ScopedBriefCache | null = null;
const briefCacheOf = (env: Env): ScopedBriefCache => {
  if (!briefCacheInstance) {
    briefCacheInstance = new ScopedBriefCache({ maxEntries: Number(env.ROUTER_BRIEF_CACHE_MAX_ENTRIES ?? 64) });
  }
  return briefCacheInstance;
};

export class TaskWorkflow extends WorkflowEntrypoint<Env, PlanParams> {
  override async run(event: WorkflowEvent<PlanParams>, step: WorkflowStep): Promise<PlanOutcome> {
    const store = new TaskStore(this.env.DB);
    try {
      if (!event.payload?.taskId || typeof event.payload.generation !== 'number') {
        throw new NonRetryableError(
          `invalid plan params: ${JSON.stringify({ taskId: event.payload?.taskId, generation: event.payload?.generation })}`,
        );
      }
      // adapter, GTD Manager и хостовая политика RunSpec строятся из env
      // (bindings), не из params: ключ Runner'а и политика исполнения не должны
      // сериализоваться в durable params экземпляра.
      const task = await store.requireTask(event.payload.taskId);
      const runtime = resolveProfileRuntime(this.env as unknown as Record<string, string | undefined>, task.profile_id);
      return await conversationPlan(cfStepCtx(step), store, { ...event.payload, profileId: task.profile_id }, {
        adapter: runtime.adapter,
        gtd: gtdServiceOf(this.env, store),
        runSpecPolicy: runtime.policy,
      });
    } catch (e) {
      // Повтор не исправит fencing и терминальный статус — валить экземпляр.
      if (isPermanent(e)) throw new NonRetryableError(String((e as Error)?.message ?? e));
      throw e;
    }
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 1), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function credentialHost(req: Request, env: Env): Promise<string | null> {
  const principal = await verifyPrincipal(req, principalAuthOf(env as unknown as Record<string, string | undefined>));
  const trusted = (env.CREDENTIAL_HOST_PRINCIPALS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return principal && trusted.includes(principal) ? principal : null;
}

const errorStatus = (e: unknown): number => {
  if (e instanceof InvalidEnvelopeError) return 400;
  if (e instanceof PrincipalUnauthorizedError) return 401;
  if (e instanceof PrincipalForbiddenError) return 403;
  if (e instanceof EnvelopeConflictError) return 409;
  if (e instanceof FencedError || e instanceof TerminalStateError) return 409;
  if (e instanceof TaskNotFoundError) return 404;
  if (e instanceof AnswerConflictError || e instanceof AnswerRejectedError) return 409;
  // Отказ контроля (P23) — с явным статусом: contract error не превращается в
  // тихий переход к output-owned recovery (§5a).
  if (e instanceof GtdError) return e.status;
  return 500;
};

/**
 * Авторизация маршрута по задаче: профиль берётся из записи в Task Store
 * (C03: «адресат команды берётся из записи в Task Store, а не из памяти»),
 * принципал — из проверенной аутентификации (X-Principal).
 */
const authorizeTaskRoute = async (
  store: TaskStore,
  req: Request,
  taskId: string,
  scope: AdmissionScope,
  auth: PrincipalAuth,
): Promise<TaskRow> => {
  const task = await store.getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  const principal = await resolvePrincipal(store, { principalId: await principalOf(req, auth) });
  requirePermission(principal, task.profile_id, scope);
  return task;
};

/**
 * Проверенная личность: подпись HMAC по binding `PRINCIPAL_SECRET`, а не доверие
 * заголовку клиента. Без секрета доступ закрыт (fail closed) — см.
 * `src/auth/principal-auth.ts`.
 */
const principalOf = async (req: Request, auth: PrincipalAuth): Promise<string> => {
  const principalId = await verifyPrincipal(req, auth);
  return principalId ?? '';
};

/** Часы расписания: прод — системные, песочница/тесты — виртуальные. */
const scheduleClockOf = (env: Env): Clock =>
  env.SCHEDULE_CLOCK ? new VirtualClock(Number(env.SCHEDULE_CLOCK)) : systemClock;

const credentialExecutionOf = (env: Env) => {
  const runnerEngine = env.ROUTER_AGENT_ENGINE?.trim();
  if (!runnerEngine) return undefined;
  try {
    const bindings = env as unknown as Record<string, string | undefined>;
    const policy = runSpecPolicyOf(bindings) as { timeoutMs?: number };
    const timeoutMs = policy.timeoutMs ?? (bindings.RUN_SPEC_TIMEOUT_MS ? Number(bindings.RUN_SPEC_TIMEOUT_MS) : undefined);
    if (!timeoutMs) return undefined;
    return { runnerEngine, runnerTimeoutSec: timeoutMs / 1000, runnerPollSec: 1 };
  } catch {
    return undefined;
  }
};

const workflowPortOf = (env: Env, store: TaskStore) =>
  new CfWorkflowPort(env.TASK_WORKFLOW, store, credentialExecutionOf(env), env.NATIVE_CANCEL_CONFIRMATION === 'true' ? {
    async stop(context) {
      const runtime = resolveProfileRuntime(env as unknown as Record<string, string | undefined>, context.profileId);
      return runtime.adapter ? runnerExternalStopPort(runtime.adapter).stop(context) : { state: 'unknown' };
    },
  } : undefined);

const scheduleServiceOf = (env: Env, store: TaskStore, port: CfWorkflowPort, clock?: Clock): ScheduleService =>
  new ScheduleService({
    store: new ScheduleStore(env.DB),
    submitter: portSubmitter(port),
    clock: clock ?? scheduleClockOf(env),
  });

/** GTD Manager (P23): тот же порт и те же часы, что у расписания (единая песочница I07). */
const gtdServiceOf = (env: Env, store: TaskStore, clock?: Clock): GtdService =>
  new GtdService({
    store: new GtdStore(env.DB),
    tasks: store,
    port: workflowPortOf(env, store),
    clock: clock ?? scheduleClockOf(env),
  });

/**
 * Task Router: `POST /route` (P16 policy + P17 recipe, этап I05).
 *
 * Вход маршрутизации — ПРИНЯТАЯ задача в Task Store, а не тело запроса:
 * профиль и текст берутся из записи (`authorizeTaskRoute` + `user_value`),
 * поэтому права нельзя вывести из текста и нельзя подменить профиль клиентом.
 * Контекст диалога, манифест вложений и typed-сигнал приходят от шлюза
 * (§11.2 шаг 2): без них контекст считается пустым, а не «полным».
 *
 * Рецепт (P17) — один вызов модели без инструментов; данные для него готовит
 * host-owned обработчик. Исполнитель отсюда НЕ запускается: при эскалации
 * возвращается заявка (AgentWorkOrder) и ЗАПРОС продолжения. Продолжение
 * (новый job/run при том же userTaskId) выдаёт только Output — единственный
 * владелец продолжения, и только по явному `continue: true` при включённой
 * политике `ROUTER_CONTINUATION_ENABLED`.
 */
async function handleRouteRoute(
  req: Request,
  body: Record<string, unknown>,
  env: Env,
  store: TaskStore,
  port: CfWorkflowPort,
  auth: PrincipalAuth,
): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const taskId = String(body.taskId ?? '');
  if (!taskId) return json({ error: 'taskId is required' }, 400);

  const task = await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
  const principal = await resolvePrincipal(store, { principalId: await principalOf(req, auth) });
  const runtime = resolveProfileRuntime(env as unknown as Record<string, string | undefined>, task.profile_id);
  const v1 = env.ROUTER_SELECTOR === 'communication_v1';
  const catalog = v1 ? communicationV1Catalog() : sandboxCapabilityCatalog();

  // Права — из идентичности: выдача capability приходит из binding'а песочницы
  // (в проде — из credential broker). Текст запроса в выдачу не входит.
  const grants = parseJsonObject<Record<string, { capabilities?: string[]; integrations?: string[] }>>(env.ROUTER_GRANTS);
  const own = grants[principal.principalId] ?? {};
  const platform = catalog.capabilities.map((c) => c.id).filter((id) => id === 'system_health' || /^(service|tasks|clock|integrations|catalog|policy)\./.test(id));
  const authorization = await deriveAuthorization(
    {
      principalId: principal.principalId,
      profileId: task.profile_id,
      scopes: principal.scopes,
      grantedCapabilityIds: [...platform, ...(own.capabilities ?? [])],
      grantedIntegrationIds: own.integrations ?? [],
    },
    catalog,
  );

  const facts = parseJsonObject<{ connections?: Record<string, boolean>; profileFields?: Record<string, string | null> }>(
    env.ROUTER_PROFILE_FACTS,
  );
  const activeRows = await store.activeTasksByProfile(task.profile_id);
  const clockMs = env.ROUTER_CLOCK ? Number(env.ROUTER_CLOCK) : Date.now();

  // Исходный текст — из принятой задачи: он неизменен и не переписывается шлюзом.
  const storedValue = task.user_value ? (JSON.parse(task.user_value) as Record<string, unknown>) : {};
  const inputItems = Array.isArray(storedValue.inputItems) ? (storedValue.inputItems as Array<{ text?: string }>) : [];
  const text = inputItems.map((item) => item.text ?? '').join('\n').trim();

  const context = (body.context ?? {}) as Record<string, unknown>;
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const typedSignal = body.typedSignal as { kind: 'button' | 'command' | 'awaiting_answer'; ref: string } | null | undefined;
  const ordinaryV1 = v1 && !typedSignal;
  if (ordinaryV1) await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
  const durableContext = ordinaryV1 ? await durableConversationContext(store, task) : undefined;
  const saved = ordinaryV1 ? await store.routingSelection(task.id, task.generation) as RouteResult | null : null;
  const communicationConfig = { url: env.COMMUNICATION_API_URL, service: env.COMMUNICATION_SERVICE, token: env.COMMUNICATION_TOKEN, timeoutMs: Number(env.COMMUNICATION_TIMEOUT_MS ?? 35_000) };

  let result = saved ?? await routeRequest(
    {
      envelope: {
        principalId: principal.principalId,
        profileId: task.profile_id,
        userTaskId: task.id,
        conversationId: task.conversation_id,
        catalogVersion: catalog.version,
        policyVersion: catalog.version,
        budgets: {
          llmCallsRemaining: Number(env.ROUTER_LLM_BUDGET ?? (ordinaryV1 ? 2 : 1)),
          agentAllowed: env.ROUTER_AGENT_ALLOWED !== 'false',
        },
        runId: null,
        requestId: task.request_id,
      },
      prepared: {
        text,
        originalInput: ordinaryV1 ? storedValue : undefined,
        durableContext,
        context: {
          pendingProposal: (context.pendingProposal as string | undefined) ?? null,
          lastAssistantText: (context.lastAssistantText as string | undefined) ?? null,
          sessionEmpty: context.sessionEmpty === undefined ? true : Boolean(context.sessionEmpty),
          relevantTurns: Number(context.relevantTurns ?? 0),
        },
        attachments: (ordinaryV1 ? inputItems.flatMap((item) => {
          const refs = item as { artifactRefs?: string[]; snapshotId?: string };
          return [...(refs.artifactRefs ?? []), ...(refs.snapshotId ? [`snapshot:${refs.snapshotId}`] : [])].map((artifactRef) => ({ artifactRef, kind: 'artifact', extracted: false, chars: null }));
        }) : attachments) as never,
        typedSignal: typedSignal ?? null,
        contextVersion: `ctx:${task.id}:${catalog.version}`,
        readinessSnapshotPresent: true,
      },
      catalog,
      authorization,
      hostFacts: {
        clockMs: Number.isFinite(clockMs) ? clockMs : Date.now(),
        connections: facts.connections ?? {},
        profileFields: facts.profileFields ?? {},
        activeTasks: activeRows.map((row) => ({ id: row.id, state: row.status, title: row.goal.slice(0, 80) })),
        tasksYesterday: [],
      },
    },
    {
      communicationV1: ordinaryV1 ? { namesOnly: env.ROUTER_SELECTOR_NAMES_ONLY === 'true', select: communicationSelector(communicationConfig), write: communicationWriter({ ...communicationConfig, timeoutMs: Number(env.COMMUNICATION_WRITER_TIMEOUT_MS ?? 10_000) }), health: () => probeRunnerHealth(runtime.adapter) } : undefined,
      source: 'http-route',
      replyOrRoute: createReplyOrRouteRunner({
        model: scriptedFixedModel({
          script: parseScript(env.ROUTER_RECIPE_SCRIPT),
          fault: readSandboxFault(env.ROUTER_RECIPE_FAULT),
        }),
        llmCallsRemaining: () => Number(env.ROUTER_LLM_BUDGET ?? 1),
        deadlineMs: Number(env.ROUTER_RECIPE_DEADLINE_MS ?? 15_000),
      }),
      modelId: 'sandbox-scripted-fixed-model',
      handler: sandboxHostCapabilityHandler(),
      brief: {
        cache: briefCacheOf(env),
        budget: {
          maxBytes: Number(env.ROUTER_BRIEF_MAX_BYTES ?? DEFAULT_BRIEF_MAX_BYTES),
          maxCandidates: Number(env.ROUTER_BRIEF_MAX_CANDIDATES ?? DEFAULT_BRIEF_MAX_CANDIDATES),
        },
      },
    },
  );
  if (ordinaryV1 && !saved) result = await store.saveRoutingSelection(task.id, task.generation, result) as RouteResult;
  if (ordinaryV1 && result.reply) await commitQuickAnswer(store, task, result);

  logStructured({
    event: 'route.dispatched',
    profileId: task.profile_id,
    userTaskId: task.id,
    runId: null,
    requestId: task.request_id,
    decisionId: result.decisionId,
    reason: result.decision.reasonCode,
    route: result.decision.route,
    agentDispatchAttempts: result.execution.agentDispatchAttempts,
    agentStarted: false,
    workOrderIssued: result.workOrder !== null,
    continuationRequested: result.continuation !== null,
    permissionSource: authorization.source,
    authorizationRef: authorization.snapshotRef,
  });

  // Продолжение выдаёт ТОЛЬКО Output — единственный владелец продолжения. Роутер
  // запрашивает, но не создаёт ни job, ни run; выдача — по явному запросу и
  // только при включённой политике (по умолчанию выключена: запуск исполнителя
  // — отдельное решение, а не побочный эффект маршрутизации).
  const continuation = ordinaryV1 && result.continuation && body.continue === true
    ? env.ROUTER_CONTINUATION_ENABLED === 'true'
      ? runtime.adapter
        ? await dispatchAcceptedAgent(store, port, task, result, env.ROUTER_AGENT_ENGINE?.trim() || 'opencode')
        : { owner: 'output', requested: true, issued: false, refusal: 'runner_not_configured' }
      : { owner: 'output', requested: true, issued: false, refusal: 'continuation_policy_disabled' }
    : await issueContinuation(result, env, store, port, body);

  return json({
    decisionId: result.decisionId,
    policyVersion: result.decision.policyVersion,
    route: result.decision.route,
    mode: result.decision.mode,
    reasonCode: result.decision.reasonCode,
    degraded: result.decision.degraded,
    degradedNotice: result.decision.degradedNotice,
    rendering: result.rendering,
    outcome: result.decision.outcome,
    needsExecutor: result.decision.needsExecutor,
    executor: result.decision.executor,
    escalation: result.decision.escalation,
    escalationAttempt: result.decision.escalationAttempt,
    replyAllowed: result.decision.replyAllowed,
    capabilityId: result.decision.capabilityId,
    coverage: result.decision.coverage,
    schemaOutcome: result.decision.schemaOutcome,
    semanticOutcome: result.decision.semanticOutcome,
    modelCalls: result.decision.modelCalls,
    firstUsefulReplyMs: result.decision.firstUsefulReplyMs,
    reply: result.reply,
    askUser: result.askUser,
    workOrder: result.workOrder,
    execution: result.execution,
    evidence: result.decision.evidence,
    continuation,
    brief: {
      ...briefBuildSummaryOf(result.brief),
      tier1: result.brief?.brief?.tier1 ?? null,
      tier2: result.brief?.brief?.tier2 ?? null,
    },
  });
}

/**
 * Выдача продолжения владельцем — Output. Возвращает блок для ответа: либо
 * созданную пару job/run, либо причину отказа. Ничего не создаёт, если
 * продолжение не запрошено явно или политика его не разрешает.
 */
async function issueContinuation(
  result: Awaited<ReturnType<typeof routeRequest>>,
  env: Env,
  store: TaskStore,
  port: CfWorkflowPort,
  body: Record<string, unknown>,
): Promise<
  | { owner: 'output'; requested: true; issued: true; jobRef: string; runId: string; generation: number; executor: 'opencode' }
  | { owner: 'output'; requested: true; issued: false; refusal: string; jobRef: null; runId: null; generation: null }
  | { owner: 'output'; requested: false; issued: false; refusal: null; jobRef: null; runId: null; generation: null }
> {
  const requested = result.continuation !== null && body.continue === true;
  if (!requested) {
    return { owner: 'output', requested: false, issued: false, refusal: null, jobRef: null, runId: null, generation: null };
  }
  if (env.ROUTER_CONTINUATION_ENABLED !== 'true') {
    return { owner: 'output', requested: true, issued: false, refusal: 'continuation_policy_disabled', jobRef: null, runId: null, generation: null };
  }
  const request = result.continuation;
  if (!request) {
    return { owner: 'output', requested: false, issued: false, refusal: null, jobRef: null, runId: null, generation: null };
  }
  const outcome = await continueFastPathEscalation(request, {
    port: portContinuationPort(port),
    store: taskStoreContinuationStore(store),
    agentAllowed: env.ROUTER_AGENT_ALLOWED !== 'false',
  });
  if (!outcome.created) {
    logStructured({
      event: CONTINUATION_EVENT,
      level: 'info',
      profileId: request.profileId,
      userTaskId: request.userTaskId,
      runId: null,
      decisionId: request.decisionId,
      owner: outcome.owner,
      issued: false,
      refusal: outcome.refusal.reason,
    });
    return { owner: 'output', requested: true, issued: false, refusal: outcome.refusal.reason, jobRef: null, runId: null, generation: null };
  }
  logStructured({
    event: CONTINUATION_EVENT,
    level: 'info',
    profileId: request.profileId,
    userTaskId: request.userTaskId,
    runId: outcome.runId,
    decisionId: request.decisionId,
    owner: outcome.owner,
    issued: true,
    jobRef: outcome.jobRef,
    generation: outcome.generation,
    executor: outcome.executor,
    reasonCode: request.reasonCode,
    continuationOwner: outcome.owner,
  });
  return {
    owner: 'output',
    requested: true,
    issued: true,
    jobRef: outcome.jobRef,
    runId: outcome.runId,
    generation: outcome.generation,
    executor: outcome.executor,
  };
}

/** Сценарий решений скриптованной модели: массив строк, по одной на вызов. */
function parseScript(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/** Разбор JSON-поля binding'а: мусорный конфиг не должен ронять маршрут. */
function parseJsonObject<T>(raw: string | undefined): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

const SANDBOX_MODEL_FAULTS: SandboxModelFault[] = [
  'none',
  'refused',
  'timeout',
  'invalid_json',
  'truncated',
  'provider_failure',
  'budget_denied',
  'semantic_invalid',
  'needs_executor',
  'clarify',
  'awaiting_input',
  'insufficient_context',
];

function readSandboxFault(raw: string | undefined): SandboxModelFault {
  return SANDBOX_MODEL_FAULTS.includes(raw as SandboxModelFault) ? (raw as SandboxModelFault) : 'none';
}

/**
 * Маршруты GTD (P23, #62).
 *
 * Контроль ВСЕГДА явный: запись создаётся только `POST /gtd` с причиной,
 * критериями, дедлайном и лимитами попыток. Ни один другой маршрут записи
 * контроля не создаёт — occurrence расписания и обычные задачи остаются без
 * gtdId (AC-141 P22 не меняется). Авторизация — по профилю записи контроля,
 * проход контроля — по профилю принципала.
 */
async function handleGtdRoute(
  req: Request,
  url: URL,
  env: Env,
  store: TaskStore,
  body: Record<string, unknown>,
  auth: PrincipalAuth,
): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean); // ['gtd', ...]
  const action = parts[1] ?? '';
  const service = gtdServiceOf(env, store);
  const identity = { principalId: await principalOf(req, auth) };

  // Явная регистрация на контроль (opt-in). Запись durable ДО запуска работы.
  if (action === '' && req.method === 'POST') {
    const profileId = String(body.profileId ?? '');
    await authorizeIntake(store, identity, profileId, 'tasks:control');
    const criteria = (Array.isArray(body.criteria) ? body.criteria : []).map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>;
      return {
        id: String(c.id ?? ''),
        description: String(c.description ?? ''),
        required: c.required === undefined ? true : Boolean(c.required),
      };
    });
    const result = await service.register({
      requestId: String(body.requestId ?? ''),
      profileId,
      userTaskId: String(body.userTaskId ?? ''),
      reason: String(body.reason ?? ''),
      criteria,
      deadlineAt: Number(body.deadlineAt ?? 0),
      maxAttempts: body.maxAttempts === undefined ? undefined : Number(body.maxAttempts),
      nextCheckAt: body.nextCheckAt === undefined ? undefined : Number(body.nextCheckAt),
      supervisedByGtdId: (body.supervisedByGtdId as string | undefined) ?? null,
      syntheticSteps: Array.isArray(body.syntheticSteps)
        ? (body.syntheticSteps as Record<string, unknown>[]).map((raw) => {
            const s = raw ?? {};
            return {
              stepOutcome: String(s.stepOutcome ?? 'succeeded') as GtdStepOutcome,
              criteria: (s.criteria as Record<string, unknown> | undefined) ?? null,
              conditionRef: (s.conditionRef as string | undefined) ?? null,
            };
          })
        : null,
    });
    return json(
      { gtdId: result.record.gtd_id, state: result.record.state, created: result.created, continuationOwner: result.record.continuation_owner, record: result.record, criteria: result.record.criteria_json ? JSON.parse(result.record.criteria_json) : [] },
      result.created ? 201 : 200,
    );
  }

  if (action === '' && req.method === 'GET') {
    const principal = await resolvePrincipal(store, identity);
    const profileId = url.searchParams.get('profileId') ?? principal.profileId;
    requirePermission(principal, profileId, 'tasks:read');
    return json({ records: await service.list(profileId) });
  }

  // Проход контроля: решения GTD по событиям/таймерам. Явный «сейчас» — только
  // для песочницы на виртуальных часах (как у /schedules/tick).
  if (action === 'tick' && req.method === 'POST') {
    const principal = await resolvePrincipal(store, identity);
    requirePermission(principal, principal.profileId, 'tasks:control');
    const now = body.now === undefined ? undefined : Number(body.now);
    if (now !== undefined && !Number.isFinite(now)) return json({ error: 'now must be a number (epoch ms)' }, 400);
    return json(await service.tick({ now, profileId: principal.profileId }));
  }

  // Durable ACK: обработать исходы записи (один владелец продолжения).
  if (action === 'ack' && req.method === 'POST') {
    const principal = await resolvePrincipal(store, identity);
    const gtdId = String(body.gtdId ?? '');
    const record = await service.get(gtdId);
    if (!record) return json({ error: 'control record not found' }, 404);
    requirePermission(principal, record.record.profile_id, 'tasks:control');
    return json(await service.ack(gtdId));
  }

  // Output -> GTD: структурированный исход шага в durable inbox.
  if (action === 'outcomes' && req.method === 'POST') {
    const principal = await resolvePrincipal(store, identity);
    const gtdId = String(body.gtdId ?? '');
    const record = await service.get(gtdId);
    if (!record) {
      // Contract error: неизвестный gtdId — карантин и явный статус, НЕ тихий
      // переход к output-owned recovery (§5a).
      const input = {
        gtdId,
        userTaskId: String(body.userTaskId ?? ''),
        runId: (body.runId as string | undefined) ?? null,
        stepId: String(body.stepId ?? ''),
        outcome: String(body.outcome ?? 'failed') as GtdStepOutcome,
        detail: (body.detail as Record<string, unknown> | undefined) ?? null,
        idempotencyKey: String(body.idempotencyKey ?? `api:${crypto.randomUUID()}`),
      };
      try {
        return json(await service.reportOutcome(input));
      } catch (e) {
        if (e instanceof GtdUnknownRecordError) {
          const quarantined = await service.quarantinedOutcome(input.gtdId, input.idempotencyKey);
          return json(
            {
              state: quarantined?.state ?? 'quarantined',
              reason: quarantined?.reason ?? 'unknown_control_record',
              reconciliationRequired: true,
              continuationOwner: 'gtd',
            },
            409,
          );
        }
        throw e;
      }
    }
    requirePermission(principal, record.record.profile_id, 'tasks:signal');
    const result = await service.reportOutcome({
      gtdId,
      userTaskId: String(body.userTaskId ?? record.record.user_task_id),
      runId: (body.runId as string | undefined) ?? null,
      stepId: String(body.stepId ?? record.record.current_step_id ?? 'step-1'),
      outcome: String(body.outcome ?? 'failed') as GtdStepOutcome,
      detail: (body.detail as Record<string, unknown> | undefined) ?? null,
      eventId: (body.eventId as number | undefined) ?? null,
      idempotencyKey: String(body.idempotencyKey ?? `api:${crypto.randomUUID()}`),
    });
    return json(result, result.accepted ? 201 : 200);
  }

  // Synthetic CI provider песочницы I07: внешний гейт закрылся отчётом.
  if (action === 'condition' && req.method === 'POST') {
    const principal = await resolvePrincipal(store, identity);
    const gtdId = String(body.gtdId ?? '');
    const record = await service.get(gtdId);
    if (!record) return json({ error: 'control record not found' }, 404);
    requirePermission(principal, record.record.profile_id, 'tasks:signal');
    return json(
      await service.reportCondition(String(body.conditionRef ?? ''), {
        gtdId,
        conclusion: String(body.conclusion ?? 'neutral') as 'success' | 'failure' | 'neutral',
        reportRef: (body.reportRef as string | undefined) ?? null,
        source: (body.source as string | undefined) ?? null,
      }),
    );
  }

  if (action === 'cancel' && req.method === 'POST') {
    const principal = await resolvePrincipal(store, identity);
    const gtdId = String(body.gtdId ?? '');
    const record = await service.get(gtdId);
    if (!record) return json({ error: 'control record not found' }, 404);
    requirePermission(principal, record.record.profile_id, 'tasks:control');
    return json({ record: await service.cancel(gtdId, { reason: (body.reason as string | undefined) ?? undefined }) });
  }

  const gtdId = action;
  if (!gtdId) return json({ error: 'not found' }, 404);
  const view = await service.get(gtdId);
  if (!view) return json({ error: 'control record not found' }, 404);
  if (req.method === 'GET') {
    const principal = await resolvePrincipal(store, identity);
    requirePermission(principal, view.record.profile_id, 'tasks:read');
    return json(view);
  }
  return json({ error: 'method not allowed' }, 405);
}

/**
 * Маршруты расписания (P22, #61).
 *
 * Авторизация — по профилю расписания (tasks:read/intake/control), как у задач.
 * Проход планировщика (`/schedules/tick`) ограничен профилем принципала: одно
 * расписание не запускается командой чужого профиля.
 */
async function handleScheduleRoute(
  req: Request,
  url: URL,
  env: Env,
  store: TaskStore,
  port: CfWorkflowPort,
  body: Record<string, unknown>,
  auth: PrincipalAuth,
): Promise<Response> {
  const path = url.pathname.slice('/schedules'.length).replace(/\/$/, '') || '/';
  const service = scheduleServiceOf(env, store, port);
  const identity = { principalId: await principalOf(req, auth) };

  if (path === '/' && req.method === 'POST') {
    const profileId = String(body.profileId ?? '');
    await authorizeIntake(store, identity, profileId, 'tasks:intake');
    const result = await service.create(profileId, {
      requestId: String(body.requestId ?? ''),
      cron: String(body.cron ?? ''),
      timezone: String(body.timezone ?? ''),
      goal: String(body.goal ?? ''),
      projectId: (body.projectId as string | undefined) ?? null,
      conversationId: (body.conversationId as string | undefined) ?? null,
      audienceId: (body.audienceId as string | undefined) ?? null,
      destinationId: (body.destinationId as string | undefined) ?? null,
      overlapPolicy: body.overlapPolicy as never,
      catchUpPolicy: body.catchUpPolicy as never,
      maxAdmitAttempts: body.maxAdmitAttempts as number | undefined,
      enabled: body.enabled as boolean | undefined,
    });
    return json({ schedule: result.schedule, created: result.created, gtdId: null }, result.created ? 201 : 200);
  }

  if (path === '/' && req.method === 'GET') {
    const principal = await resolvePrincipal(store, identity);
    const profileId = url.searchParams.get('profileId') ?? principal.profileId;
    requirePermission(principal, profileId, 'tasks:read');
    return json({ schedules: await service.list(profileId) });
  }

  // Явный «сейчас» — только для песочницы на виртуальных часах (I07). В проде
  // время берёт планировщик, а не тело запроса.
  if (path === '/tick') {
    const principal = await resolvePrincipal(store, identity);
    requirePermission(principal, principal.profileId, 'tasks:control');
    const now = body.now === undefined ? undefined : Number(body.now);
    if (now !== undefined && !Number.isFinite(now)) return json({ error: 'now must be a number (epoch ms)' }, 400);
    const report = await service.tick({ now, profileId: principal.profileId });
    return json(report);
  }

  const scheduleId = url.searchParams.get('scheduleId') ?? (body.scheduleId as string | undefined) ?? '';
  if (path === '/occurrences') {
    if (!scheduleId) return json({ error: 'scheduleId is required' }, 400);
    const schedule = await service.get(scheduleId);
    if (!schedule) return json({ error: 'schedule not found' }, 404);
    await authorizeIntake(store, identity, schedule.profile_id, 'tasks:read');
    return json({ scheduleId, occurrences: await service.occurrences(scheduleId) });
  }

  if (path === '/enable' || path === '/disable') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const id = String(body.scheduleId ?? scheduleId ?? '');
    if (!id) return json({ error: 'scheduleId is required' }, 400);
    const schedule = await service.get(id);
    if (!schedule) return json({ error: 'schedule not found' }, 404);
    await authorizeIntake(store, identity, schedule.profile_id, 'tasks:control');
    const updated = path === '/enable' ? await service.enable(id) : await service.disable(id);
    return json({ schedule: updated });
  }

  return json({ error: 'not found' }, 404);
}

/**
 * Адаптер канала для локальной песочницы: доставка подтверждается без вызова
 * провайдера (сеть/Telegram вне зоны control plane). Настоящий канал подключает
 * карточка доставки M1.4 — контракт тот же (DeliveryAdapter).
 */
const localDeliveryAdapter: DeliveryAdapter = {
  send: async (delivery) => ({ providerMessageId: `local-${delivery.channel}-${delivery.id.slice(0, 8)}` }),
};

/**
 * Сверка манифестов артефактов с Runner'ом (read-only, идемпотентно).
 *
 * Нужна из-за дефекта Runner'а: `POST /v1/runs` принимает `outputs`, но
 * `assembleSpec` не копирует его в RunSpec — объявленные выходы не экспортируются,
 * и `result.outputRefs` остаётся пустым (зафиксировано живым прогоном и
 * возвращает в #23 как СТОП). Контроллер здесь ничего не создаёт: он читает
 * УЖЕ сохранённые манифесты Runner'а (`GET /v1/runs/{runId}/artifacts`) и
 * записывает недостающие ссылки в `task_artifacts`.
 *
 * Ни spawn, ни записи в workspace, ни ручной загрузки байтов: манифесты —
 * собственность Runner'а, control plane их только перечитывает.
 */
async function reconcileArtifacts(env: Env, store: TaskStore, taskId: string): Promise<unknown> {
  const task = await store.requireTask(taskId);
  const { adapter } = resolveProfileRuntime(env as unknown as Record<string, string | undefined>, task.profile_id);
  if (!adapter) return json({ error: 'runner not configured' }, 503);

  const runs = await store.listRuns(taskId);
  const before = (await store.listArtifacts(taskId)).length;
  const seen = new Set<string>();
  const failed: string[] = [];

  for (const run of runs) {
    const runnerRunId = run.session_id;
    if (!runnerRunId) continue;
    let manifests;
    try {
      manifests = await adapter.artifacts(runnerRunId);
    } catch (e) {
      failed.push(`${runnerRunId}: ${String((e as Error)?.message ?? e)}`);
      continue;
    }
    for (const manifest of manifests) {
      const ref = manifest.ref;
      if (seen.has(ref)) continue;
      seen.add(ref);
      await store.recordArtifact({
        taskId,
        kind: 'file',
        artifactRef: ref,
        sizeBytes: manifest.size,
        checksum: manifest.sha256 ? `sha256:${manifest.sha256}` : null,
        runId: run.id,
        generation: task.generation,
      });
    }
  }

  const after = (await store.listArtifacts(taskId)).length;
  logStructured({
    event: 'artifacts.reconciled',
    profileId: task.profile_id,
    userTaskId: taskId,
    reason: 'runner_manifest_rescan',
    added: after - before,
    total: after,
    runnerFailures: failed.length,
  });
  return { taskId, added: after - before, total: after, scanned: seen.size, runnerFailures: failed };
}

/**
 * Байты артефакта наружу — read-only прокси к Runner'у.
 *
 * Ключ Runner'а остаётся в binding воркера: клиент получает файл по
 * аутентифицированному URL `/artifact?taskId=…&ref=…`, а не по ссылке с ключом
 * внутри. Сначала ищем артефакт в `task_artifacts` (ссылка + манифест), потом —
 * по манифестам Runner'а для этого рана. Никакой записи в workspace и никакой
 * подмены результата: это чтение уже сохранённого выхода.
 */
async function serveArtifact(env: Env, store: TaskStore, taskId: string, ref: string): Promise<Response> {
  const task = await store.requireTask(taskId);
  const { adapter } = resolveProfileRuntime(env as unknown as Record<string, string | undefined>, task.profile_id);
  if (!adapter) return json({ error: 'runner not configured' }, 503);

  const artifacts = await store.listArtifacts(taskId);
  const row = artifacts.find((a) => a.artifact_ref === ref);
  if (!row) return json({ error: 'artifact not found' }, 404);

  // runId попытки control plane и runId Runner'а — РАЗНЫЕ идентификаторы
  // (attachRunnerRun кладёт runId Runner'а в executions.session_id). Манифесты
  // Runner'а ищем по его runId, а не по нашему.
  const attempt = row.run_id ? await store.getRun(row.run_id) : null;
  const runnerRunId = attempt?.session_id ?? null;
  const candidates: string[] = [];
  if (runnerRunId) {
    try {
      for (const manifest of await adapter.artifacts(runnerRunId)) {
        if ((manifest.ref === ref || manifest.artifactId === ref) && manifest.artifactId) candidates.push(manifest.artifactId);
      }
    } catch {
      // Манифесты недоступны — пробуем ссылку как artifactId.
    }
  }
  if (!candidates.includes(ref)) candidates.push(ref);

  let lastError = 'artifact not found';
  for (const artifactId of candidates) {
    try {
      const { body, artifact } = await adapter.artifactBytes(artifactId);
      const owner = await store.getTask(taskId);
      logStructured({
        event: 'artifact.served',
        profileId: owner?.profile_id ?? null,
        userTaskId: taskId,
        runId: artifact.runId,
        reason: 'read_only_proxy',
        artifactId: artifact.artifactId,
        sizeBytes: artifact.size,
        sha256: artifact.sha256,
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': artifact.mime || 'application/octet-stream',
          'content-length': String(body.length),
          'x-artifact-sha256': artifact.sha256,
          'x-artifact-id': artifact.artifactId,
          'content-disposition': `attachment; filename="${artifact.name}"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (e) {
      lastError = String((e as Error)?.message ?? e);
    }
  }
  return json({ error: 'artifact unavailable', reason: lastError }, 502);
}

/**
 * Локальный HTTP-слой для воспроизводимого прогона (см. README «Как запустить»):
 *   POST /start {taskId, profileId, goal, ...}  -> submit (ранний ответ)
 *   POST /signal {taskId, type, payload, idempotencyKey}
 *   POST /cancel {taskId}  ·  /status {taskId}  ·  POST /recover
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
const store = new TaskStore(env.DB);
     const port = workflowPortOf(env, store);
    // Проверяющая аутентификация: секрет только в binding, в запросе его нет.
    const auth = principalAuthOf(env as unknown as Record<string, string | undefined>);
     // Конфиг пилота читается из env рантайма (process.env в Workers нет).
     const intake = new IntakeService(store, new PilotRouter({ env: env as unknown as Record<string, string | undefined> }));
    const body: Record<string, unknown> =
      req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const taskId = (body.taskId as string | undefined) ?? url.searchParams.get('taskId');

    try {
      if (url.pathname === '/') {
        return json({
          service: 'trained-assist-control-plane',
          endpoints: [
            '/intake',
            '/receipt',
            '/route',
            '/start',
            '/signal',
            '/cancel',
            '/status',
            '/recover',
            '/schedules',
            '/schedules/enable',
            '/schedules/disable',
            '/schedules/tick',
            '/schedules/occurrences',
            '/gtd',
            '/gtd/tick',
            '/gtd/ack',
            '/gtd/outcomes',
            '/gtd/condition',
            '/gtd/cancel',
          ],
        });
      }
      if (url.pathname === '/recover') return json(await port.recover());

      // Маршруты попытки исполняются по runId, а не по taskId.
      if (url.pathname === '/connection-lost') {
        const run = await port.markConnectionLost(
          body.runId as string,
          (body.reason as string | undefined) ?? 'connection_lost',
        );
        return json({ runId: run.id, status: run.status, errorClass: run.error_class, taskId: run.task_id });
      }
      if (url.pathname === '/heartbeat') {
        const run = await port.heartbeat(body.runId as string, body.leaseSec as number | undefined);
        return json({ runId: run.id, status: run.status, leaseUntil: run.lease_until });
      }

      // Приём задачи (P04/C01): квитанция выдаётся только после durable
      // сохранения; повтор с тем же requestId возвращает прежнюю квитанцию.
       if (url.pathname === '/intake') {
         if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
 const result = await intake.admit({ principalId: await principalOf(req, auth) }, {
           ...body,
           projectId: (body.projectId as string | undefined) ?? null,
           audienceId: (body.audienceId as string | undefined) ?? null,
           destinationId: (body.destinationId as string | undefined) ?? null,
         });
         return json(
           {
             receiptId: result.receipt.receiptId,
             requestId: result.receipt.requestId,
             userTaskId: result.userTaskId,
             profileId: result.receipt.profileId,
             acceptedAt: result.receipt.acceptedAt,
             durable: true,
             duplicate: result.duplicate,
             pilotRoute: result.pilotRoute ?? null,
             pilotReason: result.pilotReason ?? null,
           },
           result.duplicate ? 200 : 201,
         );
       }
      if (url.pathname === '/events') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
        const after = url.searchParams.get('after');
        const limit = Number(url.searchParams.get('limit') ?? '100');
        const page = await store.eventsAfter(taskId, after ? Number(after) : null, Number.isFinite(limit) ? limit : 100);
        return json({
          events: page.events.map(toC02Event),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      }
      // Outbox доставки: постановка и чтение. Отправку делает единственный
      // владелец — воркер доставки (delivery-worker.ts), адаптер канала в песочнице
      // локальный (M1.4 подключит настоящий канал).
      if (url.pathname === '/deliveries') {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
        const { delivery, queued } = await store.queueDelivery({
          taskId,
          logicalMessageId: (body.logicalMessageId as string | undefined) ?? `msg-${crypto.randomUUID()}`,
          channel: (body.channel as string | undefined) ?? 'api',
          message: body.message ?? {},
          eventId: (body.eventId as number | undefined) ?? null,
        });
        return json({ deliveryId: delivery.id, status: delivery.status, queued }, queued ? 201 : 200);
      }
      if (url.pathname === '/deliveries/deliver') {
        const owner = (body.owner as string | undefined) ?? 'local-worker';
        const result = await deliverOnce(store, owner, localDeliveryAdapter, {
          taskId: (body.taskId as string | undefined) ?? null,
          channel: (body.channel as string | undefined) ?? null,
          maxAttempts: (body.maxAttempts as number | undefined) ?? 3,
          retryAfterSec: (body.retryAfterSec as number | undefined) ?? 0,
        });
        return result ? json(result) : json({ delivered: false, reason: 'outbox empty' });
      }
      if (url.pathname === '/artifact') {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        const taskId = url.searchParams.get('taskId');
        const ref = url.searchParams.get('ref');
        if (!taskId || !ref) return json({ error: 'taskId and ref are required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
        return await serveArtifact(env, store, taskId, ref);
      }
      if (url.pathname === '/artifacts/reconcile') {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
        return json(await reconcileArtifacts(env, store, taskId));
      }
      if (url.pathname === '/artifacts') {
        if (req.method !== 'POST') {
          if (!taskId) return json({ error: 'taskId is required' }, 400);
          await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
          return json({ artifacts: await store.listArtifacts(taskId) });
        }
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
        const { artifact, created } = await store.recordArtifact({
          taskId,
          kind: (body.kind as string | undefined) ?? 'file',
          artifactRef: body.artifactRef as string,
          sizeBytes: (body.sizeBytes as number | undefined) ?? null,
          checksum: (body.checksum as string | undefined) ?? null,
          runId: (body.runId as string | undefined) ?? null,
        });
        return json({ artifactId: artifact.artifact_id, artifactRef: artifact.artifact_ref, created }, created ? 201 : 200);
      }
      // Host-owned interaction (шаг 5, гейт #115): durable ожидание и ответ по
      // ЯВНОМУ адресу awaitingInputId. Это и есть поверхность, которую дёргает
      // host-owned MCP tool исполнителя и канал пользователя.
      if (url.pathname === '/awaiting' || url.pathname.startsWith('/awaiting/')) {
        if (req.method === 'POST' && url.pathname === '/awaiting') {
          if (!taskId) return json({ error: 'taskId is required' }, 400);
          const task = await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
          const purpose = (body.purpose as AwaitingPurpose | undefined) ?? 'missing_fact';
          let credential: CredentialRequirement | undefined;
          if (purpose === 'credential') {
            const hostPrincipalId = await credentialHost(req, env);
            if (!hostPrincipalId) return json({ error: 'trusted credential host required' }, 403);
            const requirement = body.credential as Partial<CredentialRequirement> | undefined;
            credential = { hostPrincipalId, provider: requirement?.provider ?? '',
              bindingRef: requirement?.bindingRef ?? '', providerSessionRef: requirement?.providerSessionRef ?? '' };
          }
          const opened = await store.openAwaiting({
            taskId,
            purpose,
            kind: body.kind as AwaitingKind | undefined,
            question: (body.question as string | undefined) ?? 'Нужен ваш ответ.',
            respondentScope: (body.respondentScope as string | undefined) ?? task.profile_id,
            step: (body.step as string | undefined) ?? null,
            runId: (body.runId as string | undefined) ?? null,
            schema: credential ? { credential } : body.options ? { options: body.options } : undefined,
            checkpointRef: (body.checkpointRef as string | undefined) ?? null,
            deadlineAt: (body.deadlineAt as number | undefined) ?? undefined,
            engineRefs: {
              sessionRef: (body.engineSessionRef as string | undefined) ?? null,
              requestRef: (body.engineRequestRef as string | undefined) ?? null,
              toolCallRef: (body.toolCallRef as string | undefined) ?? null,
            },
          });
          const row = await store.getAwaiting(opened.awaitingInputId);
          logStructured({
            event: 'awaiting.opened',
            profileId: task.profile_id,
            userTaskId: taskId,
            runId: (body.runId as string | undefined) ?? null,
            requestId: task.request_id,
            awaitingInputId: opened.awaitingInputId,
            reason: 'host_opened',
            purpose,
            kind: row?.kind,
            deadlineAt: row?.deadline_at,
          });
          return json(
            {
              awaitingInputId: opened.awaitingInputId,
              kind: row?.kind,
              purpose: row?.purpose,
              status: row?.status,
              deadlineAt: row?.deadline_at,
              generation: row?.generation,
              version: row?.version,
            },
            201,
          );
        }

        const parts = url.pathname.split('/').filter(Boolean); // ['awaiting', id?, 'answer'?]
        const awaitingInputId = parts[1] ?? null;
        if (!awaitingInputId) return json({ error: 'awaitingInputId is required' }, 400);

        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'credential-ready') {
          const hostPrincipalId = await credentialHost(req, env);
          if (!hostPrincipalId) return json({ error: 'trusted credential host required' }, 403);
          const row = await store.getAwaiting(awaitingInputId);
          if (!row) return json({ error: 'awaiting not found' }, 404);
          await authorizeTaskRoute(store, req, row.user_task_id, 'tasks:signal', auth);
          if (body.status !== 'ready' || body.preflight === true || body._zerocreds_preflight === true
            || req.headers.get('x-zerocreds-preflight') === 'true') {
            return json({ error: 'verified readiness required' }, 409);
          }
          const input: CredentialReadyEvent = { hostPrincipalId, awaitingInputId,
            eventId: body.eventId as string, userTaskId: body.userTaskId as string,
            profileId: body.profileId as string, provider: body.provider as string,
            bindingRef: body.bindingRef as string, providerSessionRef: body.providerSessionRef as string,
            generation: body.generation as number, version: body.version as number };
          return json(await port.completeCredential(input));
        }

        if (req.method === 'GET' && parts.length === 2) {
          const row = await store.getAwaiting(awaitingInputId);
          if (!row) return json({ error: 'awaiting not found' }, 404);
          await authorizeTaskRoute(store, req, row.user_task_id, 'tasks:read', auth);
          return json({ ...row, answer: row.answer_json ? JSON.parse(row.answer_json) : null });
        }

        if (req.method === 'POST' && parts[2] === 'answer') {
          const row = await store.getAwaiting(awaitingInputId);
          if (!row) return json({ error: 'awaiting not found' }, 404);
          const task = await authorizeTaskRoute(store, req, row.user_task_id, 'tasks:signal', auth);
          const idempotencyKey = (body.idempotencyKey as string | undefined) ?? `api:${crypto.randomUUID()}`;
          try {
            const applied = await store.answerAwaitingById({
              awaitingInputId,
              idempotencyKey,
              answer: body.answer ?? null,
              step: (body.step as string | undefined) ?? null,
            });
            logStructured({
              event: applied.duplicate ? 'awaiting.answer_duplicate' : 'awaiting.answered',
              profileId: task.profile_id,
              userTaskId: row.user_task_id,
              runId: row.run_id,
              requestId: task.request_id,
              awaitingInputId,
              reason: applied.duplicate ? 'duplicate_request_id' : 'answer_applied',
              idempotencyKey,
              generation: task.generation,
            });
            return json({
              applied: applied.applied,
              duplicate: applied.duplicate,
              awaitingInputId: applied.awaitingInputId,
              answer: applied.answer,
              answeredAt: applied.answeredAt,
            });
          } catch (e) {
            const reason =
              e instanceof AnswerConflictError
                ? 'answered_with_other_key'
                : e instanceof AnswerRejectedError
                  ? `awaiting_${e.awaitingStatus}`
                  : 'answer_failed';
            logStructured({
              event: 'awaiting.answer_rejected',
              level: 'warn',
              profileId: task.profile_id,
              userTaskId: row.user_task_id,
              runId: row.run_id,
              requestId: task.request_id,
              awaitingInputId,
              reason,
              idempotencyKey,
              generation: task.generation,
            });
            throw e;
          }
        }
        return json({ error: 'method not allowed' }, 405);
      }
      if (url.pathname === '/runner/health') {
        const adapter = runnerAdapterOf(env);
        if (!adapter) return json({ configured: false });
        try {
          const status = await adapter.status('probe-run');
          return json({ configured: true, reachable: true, state: status.state });
        } catch (e) {
          // 404 = Runner ответил (доступен); сеть/5xx = недоступен.
          const reachable = e instanceof RunnerNotFoundError;
          return json({
            configured: true,
            reachable,
            error: reachable ? null : e instanceof RunnerUnavailableError ? 'unavailable' : 'error',
            message: reachable ? null : String((e as Error)?.message ?? e),
          });
        }
      }
      // ── Расписание (P22, этап I07) ──────────────────────────────
      // Расписание создаёт occurrences, occurrence — обычную задачу. Ни один
      // маршрут здесь не отменяет уже принятые задачи: disable меняет только
      // разрешение будущих срабатываний (AC-140).
      if (url.pathname.startsWith('/schedules')) {
        return await handleScheduleRoute(req, url, env, store, port, body, auth);
      }
      // ── GTD: opt-in регистрация и bounded control (P23, этап I07) ───────
      // Контроль появляется только здесь и только по явному вызову: обычная
      // задача и occurrence расписания остаются без записи контроля.
      if (url.pathname === '/gtd' || url.pathname.startsWith('/gtd/')) {
        return await handleGtdRoute(req, url, env, store, body, auth);
      }

      // ── Task Router (P16, этап I05): решение маршрута по принятой задаче ──
      if (url.pathname === '/route') {
        return await handleRouteRoute(req, body, env, store, port, auth);
      }

      if (url.pathname === '/receipt') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        const receipt = await store.acceptReceipt(taskId);
        if (!receipt) return json({ error: 'receipt not found' }, 404);
        return json({ ...receipt, durable: true });
      }
      if (url.pathname === '/report') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
        const view = await reportView(store, taskId);
        return json(view);
      }
      if (url.pathname === '/report/history') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
        const after = url.searchParams.get('after');
        const limit = Number(url.searchParams.get('limit') ?? '100');
        const history = await reportHistory(store, taskId, after ? Number(after) : null, Number.isFinite(limit) ? limit : 100);
        return json(history);
      }

      if (!taskId) return json({ error: 'taskId is required' }, 400);

      switch (url.pathname) {
        case '/start': {
          await authorizeTaskRoute(store, req, taskId, 'tasks:intake', auth);
          // Управляемая работа (P23): gtdId обязателен и проверяется хостом
          // (запись контроля принадлежит этой задаче и ещё открыта). Без gtdId
          // запуск остаётся обычной работой: gtdId=null, владелец продолжения
          // output (AC-141 не меняется).
          const gtdId = (body.gtdId as string | undefined) ?? null;
          let managed: ManagedGtdContext | null = null;
          if (gtdId) {
            const record = await gtdServiceOf(env, store).requireManagedTask(gtdId, taskId);
            managed = {
              gtdId,
              stepId: record.current_step_id ?? 'step-1',
              attempt: record.attempts + 1,
              stepOutcome: (body.stepOutcome as GtdStepOutcome | undefined) ?? 'succeeded',
            };
          }
          const input: SubmitInput = {
            id: taskId,
            profileId: (body.profileId as string | undefined) ?? 'default',
            goal: (body.goal as string | undefined) ?? taskId,
            conversationId: (body.conversationId as string | undefined) ?? null,
            question: body.question as string | undefined,
            waitTimeoutSec: body.waitTimeoutSec as number | undefined,
            crashRunOnce: body.crashRunOnce as boolean | undefined,
            runnerEngine: body.runnerEngine as string | undefined,
            autoRun: body.autoRun as boolean | undefined,
            gtd: managed,
            criteria: (body.criteria as Record<string, unknown> | undefined) ?? null,
            conditionRef: (body.conditionRef as string | undefined) ?? null,
          };
const startResult = await port.submit(input);
           return json({
             ...startResult,
             pilotRoute: startResult.pilotRoute,
             pilotReason: startResult.pilotReason,
           });
         }
        case '/signal':
          await authorizeTaskRoute(store, req, taskId, 'tasks:signal', auth);
          return json(
            await port.signal(taskId, (body.type as string | undefined) ?? 'user_reply', body.payload ?? {}, {
              idempotencyKey: body.idempotencyKey as string | undefined,
              source: body.source as 'telegram' | 'web' | 'api' | 'cron' | 'system' | undefined,
            }),
          );
        case '/cancel':
          await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
          return json(await port.cancel(taskId, { reason: body.reason as string | undefined }));
        case '/status':
          await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
          return json(await port.status(taskId));
        case '/replay':
          await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
          return json(await port.replay(taskId, { fromStep: body.fromStep as string | undefined }));
        case '/resume':
          await authorizeTaskRoute(store, req, taskId, 'tasks:control', auth);
          return json(
            await port.resume(taskId, {
              reason: body.reason as string | undefined,
              instructions: body.instructions as string | undefined,
            }),
          );
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e), name: (e as Error)?.name }, errorStatus(e));
    }
  },

  /**
   * Планировщик сквозного watchdog (arch#132, Приоритет 3c).
   *
   * Детектор без планировщика — мёртвый код: `runStuckInputSweep` никто не звал.
   * Здесь — внешний триггер (Cron Trigger), который живёт ВНЕ накопителя и поэтому
   * видит зависший вход даже тогда, когда аларм того DO сломан или не взведён.
   *
   * Контроль работоспособности самого планировщика: каждый успешный проход пишет
   * отметку в Task Store. Независимая проверка (отдельный триггер/оператор) читает
   * её и алертит, если отметка устарела — иначе планировщик может умереть молча.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.PREVIEW_ONLY === 'true') return;
    const store = new TaskStore(env.DB);
    const adapter = await resolveDeliveryAdapter(env);
    await workflowPortOf(env, store).recoverCredentialContinuations();

    // Детектор наблюдает и уведомляет; переход состояния и запуск выполняет
    // существующий авторитетный владелец (Output/Router), не планировщик.
    const result = await runStuckInputSweep(store, { adapter, retryAfterSec: 60 });

    // Отметка работоспособности: только после успешного прохода. Сбой прохода не
    // должен выглядеть как «всё в порядке».
    await store.markWatchdogRun({
      at: Date.now(),
      scanned: result.scanned,
      queued: result.queued,
      delivered: result.delivered,
      skippedStale: result.skippedStale,
      alerts: result.alerts,
      oldestAgeMs: result.oldestAgeMs,
    });

    // Отметка устарела — планировщик не работает. Это отдельный инцидент, не
    // смешанный с «просроченный вход»: у них разные владельцы и разные действия.
    const last = await store.lastWatchdogRun();
    if (!last || Date.now() - last.last_run_at > WATCHDOG_STALE_MS) {
      console.error(JSON.stringify({
        event: 'intake.watchdog_scheduler_stale',
        level: 'error',
        reason: 'scheduler_not_running',
        lastAt: last?.last_run_at ?? null,
        ageMs: last ? Date.now() - last.last_run_at : null,
      }));
    }
  },
};
