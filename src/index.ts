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
import {
  IngressArtifactRejectedError,
  IngressArtifactUnavailableError,
  IntakeService,
  ingressArtifactVerifierOf,
  inputManifestForTask,
  resolveDeliveryAdapter,
  runStuckInputSweep,
} from './intake';

/**
 * Насколько устаревшей должна быть отметка планировщика, чтобы это стало инцидентом.
 * Триггер идёт раз в минуту; 30 минут без отметки = планировщик умер молча.
 */
const WATCHDOG_STALE_MS = 30 * 60_000;
import { logError, logStructured, resolveErrorPublisher, setErrorPublisher } from './logging';
import { EnvelopeConflictError, PrincipalForbiddenError, PrincipalUnauthorizedError } from './intake/errors';
import { AnswerConflictError, AnswerRejectedError } from './taskstore/errors';
import type { CredentialReadyEvent, CredentialRequirement } from './awaiting/credential-ready';
import { runnerAdapterOf } from './runner-adapter';
import { RunnerApiAdapter } from './runner-adapter/runner-api-adapter';
import { RunnerConflictError, RunnerNotFoundError, RunnerUnavailableError } from './runner-adapter/errors';
import { runSpecPolicyOf } from './run-spec/run-spec';
import { ProfileRuntimeConfigurationError, resolveProfileRuntime } from './run-spec/profile-runtime';
import { runnerExternalStopPort } from './workflow-port/external-stop';
import { runnerEngineOf } from './runner-adapter/engine-default';
import { CpStopTargetsService, cpStopTargetsInputOf } from './workflow-port/external-stop';
import { TELEGRAM_UX_SANDBOX } from './deployment/telegram-ux-sandbox';
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
import { communicationV1Catalog, durableConversationContext, probeRunnerHealth, probeWatcherHealth } from './router/communication-v1';
import { registryFixtureHostMcp } from './router/registry-test-mcp';
import { commitQuickAnswer, dispatchAcceptedAgent, persistMcpTaskBlock } from './output/communication-v1';
import { observeHealthCatalogue, parseHealthCatalogue } from './diagnostics/health-catalogue';
import { traceTask } from './diagnostics/trace';
import type { RouteResult } from './router/service';
import {
  continueFastPathEscalation,
  portContinuationPort,
  taskStoreContinuationStore,
  CONTINUATION_EVENT,
} from './output';

export interface Env {
  BUILD_SHA?: string;
  HEALTH_DIAGNOSTICS_TOKEN?: string;
  HEALTH_CATALOGUE_JSON?: string;
  HEALTH_PROBE_TIMEOUT_MS?: string;
  HEALTH_CACHE_TTL_MS?: string;
  SANDBOX_READINESS_ENABLED?: string;
  PILOT_ENABLED?: string;
  PILOT_COHORT_PROFILE_IDS?: string;
  NATIVE_CANCEL_CONFIRMATION?: string;
  ROUTER_SELECTOR_NAMES_ONLY?: string;
  ROUTER_SELECTOR?: string;
  COMMUNICATION_API_URL?: string;
  COMMUNICATION_SERVICE?: Fetcher;
  /** Test-only direct Worker binding to the isolated Registry MCP host. */
  REGISTRY_MCP_HOST_SERVICE?: Fetcher;
  COMMUNICATION_TOKEN?: string;
  COMMUNICATION_TIMEOUT_MS?: string;
  COMMUNICATION_WRITER_TIMEOUT_MS?: string;
  ROUTER_AGENT_ENGINE?: string;
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
  /** Private service binding to the passive ingress artifact buffer. */
  INGRESS_BUFFER?: Fetcher;
  /** Shared secret authorizing CP access to the private ingress buffer. */
  INGRESS_BUFFER_TOKEN?: string;
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
  /**
   * Error Watcher push intake (I2): URL и ключ источника. Без пары
   * ERROR_WATCHER_URL+ERROR_WATCHER_KEY публикация error-событий выключена.
   */
  ERROR_WATCHER_URL?: string;
  ERROR_WATCHER_KEY?: string;
  /** Serverless Agent API (ai-agent-runner). Только из env, в репозитории нет. */
  RUNNER_API_URL?: string;
  SANDBOX_RUNNER_MOCK_TEST_URL?: string;
  RUNNER_API_KEY?: string;
  RUNNER_API_KEY_TELEGRAM_UX?: string;
  /** Separate disposable credential for the sandbox-only mock-test probe. */
  RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST?: string;
  SANDBOX_RUNNER_MOCK_PROBE_ENABLED?: string;
  RUN_SPEC_PROFILE_OVERRIDES?: string;
  /** Test-only Bearer used only by the pinned tools/list discovery binding. */
  MCP_TEST_AUTH_TOKEN?: string;
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
  /** Dedicated HMAC credential for the isolated Telegram UX test principal. */
  PRINCIPAL_SECRET_TELEGRAM_UX?: string;
  /** Dedicated HMAC credential for the isolated integration-v1 sandbox principal. */
  PRINCIPAL_SECRET_INTEGRATION_V1?: string;
  /** Dedicated HMAC credential for the test-only Telegram UX sandbox smoke principal. */
  PRINCIPAL_SECRET_CODEX_SMOKE?: string;
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

const diagnosticsJson = (value: unknown, status = 200): Response => new Response(JSON.stringify(value, null, 1), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
});

const SANDBOX_MOCK_PROBE_TASK_ID = 'sandbox-bootstrap-runner-mock-probe-v1';
const SANDBOX_MOCK_PROBE_IDEMPOTENCY_KEY = 'sandbox-bootstrap-runner-mock-probe-v1';

function sandboxMockProbeAdapter(env: Env): { adapter: RunnerApiAdapter | null; runnerBaseUrl: string | null; bindingIssue: string | null } {
  const baseUrl = env.SANDBOX_RUNNER_MOCK_TEST_URL?.trim();
  const apiKey = env.RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST?.trim();
  if (!baseUrl) return { adapter: null, runnerBaseUrl: null, bindingIssue: 'runner_url_missing' };
  if (!apiKey) return { adapter: null, runnerBaseUrl: null, bindingIssue: 'mock_key_missing' };
  if (baseUrl !== TELEGRAM_UX_SANDBOX.runnerMockTestUrl) {
    return { adapter: null, runnerBaseUrl: null, bindingIssue: 'runner_url_target_mismatch' };
  }
  return { adapter: new RunnerApiAdapter(TELEGRAM_UX_SANDBOX.runnerMockTestUrl, apiKey),
    runnerBaseUrl: TELEGRAM_UX_SANDBOX.runnerMockTestUrl, bindingIssue: null };
}

async function sandboxRunnerReachability(runnerBaseUrl: string): Promise<{ outcome: string; httpStatus: number | null }> {
  try {
    const response = await fetch(`${runnerBaseUrl}/v1/capabilities`, {
      method: 'GET', headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(5000),
    });
    return { outcome: response.status === 401 ? 'reachable_auth_required' : 'http_response', httpStatus: response.status };
  } catch {
    return { outcome: 'fetch_failed', httpStatus: null };
  }
}

function sandboxRunnerProbeErrorCode(error: unknown): string {
  if (error instanceof RunnerConflictError) {
    return error.apiCode ?? /^([A-Z][A-Z0-9_]{1,63}):/.exec(error.message)?.[1] ?? 'runner_request_rejected';
  }
  if (error instanceof RunnerNotFoundError) return 'runner_resource_not_found';
  if (error instanceof RunnerUnavailableError) return 'runner_unavailable';
  return 'probe_internal_error';
}

async function sandboxRunnerMockProbe(adapter: RunnerApiAdapter): Promise<{
  runId: string;
  state: string;
  answer: string | null;
  outcome: string;
}> {
  const receipt = await adapter.submit({
    userTaskId: SANDBOX_MOCK_PROBE_TASK_ID,
    conversationId: SANDBOX_MOCK_PROBE_TASK_ID,
    engineName: 'mock-test',
    inputText: 'Return exactly pong.',
    idempotencyKey: SANDBOX_MOCK_PROBE_IDEMPOTENCY_KEY,
    timeoutMs: 5000,
  });
  let status = await adapter.status(receipt.runId);
  for (let attempt = 0; attempt < 4 && !['succeeded', 'failed', 'cancelled'].includes(status.state); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 200));
    status = await adapter.status(receipt.runId);
  }
  if (status.runId !== receipt.runId || status.userTaskId !== SANDBOX_MOCK_PROBE_TASK_ID || status.state !== 'succeeded'
    || status.answer !== 'pong') {
    return { runId: receipt.runId, state: status.state, answer: status.answer ?? null, outcome: 'not_accepted' };
  }
  const result = await adapter.result(receipt.runId);
  if (result.runId !== receipt.runId || result.userTaskId !== SANDBOX_MOCK_PROBE_TASK_ID
    || result.outcome !== 'succeeded' || result.text !== 'pong' || result.persistence !== 'not_required'
    || result.cleanup !== 'completed') {
    return { runId: receipt.runId, state: status.state, answer: status.answer ?? null, outcome: 'contract_mismatch' };
  }
  return { runId: receipt.runId, state: status.state, answer: status.answer, outcome: result.outcome };
}

const diagnosticsTokenMatches = (request: Request, configured: string | undefined): boolean => {
  const expected = configured?.trim() ?? '';
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!expected || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return difference === 0;
};

const healthCatalogueCache = new Map<string, { expiresAt: number; summary: Record<string, unknown> }>();

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
  if (e instanceof IngressArtifactRejectedError) return 403;
  if (e instanceof IngressArtifactUnavailableError) return 503;
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

const authorizePrincipalScope = async (
  store: TaskStore,
  req: Request,
  scope: AdmissionScope,
  auth: PrincipalAuth,
): Promise<void> => {
  const principal = await resolvePrincipal(store, { principalId: await principalOf(req, auth) });
  requirePermission(principal, principal.profileId, scope);
};

const serveIngressInputArtifact = async (env: Env, task: TaskRow, manifest: NonNullable<Awaited<ReturnType<typeof inputManifestForTask>>>, ref: string, version: string): Promise<Response> => {
  const bufferToken = String(env.INGRESS_BUFFER_TOKEN ?? '').trim();
  if (!env.INGRESS_BUFFER || !bufferToken) return json({ error: 'input artifact transport unavailable' }, 503);
  const artifact = manifest.inputItems.flatMap((item) => item.artifacts).find((entry) => entry.ref === ref && entry.version === version);
  if (!artifact) return json({ error: 'input artifact not found' }, 404);
  const url = new URL('https://ingress-buffer/v1/artifacts/content');
  url.searchParams.set('profileId', task.profile_id);
  url.searchParams.set('ref', artifact.ref);
  url.searchParams.set('version', artifact.version);
  let response: Response;
  try {
    response = await env.INGRESS_BUFFER.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${bufferToken}` } });
  } catch {
    return json({ error: 'input artifact transport unavailable' }, 503);
  }
  if (response.status === 404) return json({ error: 'input artifact not found' }, 404);
  if (response.status >= 500) return json({ error: 'input artifact transport unavailable' }, 503);
  if (!response.ok) return json({ error: 'input artifact access denied' }, 403);
  const metadataMatches = response.headers.get('x-artifact-ref') === artifact.ref
    && response.headers.get('x-artifact-version') === artifact.version
    && response.headers.get('x-artifact-owner-profile-id') === task.profile_id
    && response.headers.get('x-artifact-size-bytes') === String(artifact.sizeBytes)
    && response.headers.get('x-artifact-sha256') === artifact.sha256
    && response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === artifact.mediaType
    && response.headers.get('content-length') === String(artifact.sizeBytes);
  if (!metadataMatches) {
    await response.body?.cancel();
    return json({ error: 'input artifact metadata mismatch' }, 409);
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      'content-type': artifact.mediaType,
      'content-length': String(artifact.sizeBytes),
      'cache-control': 'private, no-store',
      'x-artifact-ref': artifact.ref,
      'x-artifact-version': artifact.version,
      'x-artifact-owner-profile-id': task.profile_id,
      'x-artifact-size-bytes': String(artifact.sizeBytes),
      'x-artifact-sha256': artifact.sha256,
    },
  });
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
  const hostMcp = ordinaryV1 && env.REGISTRY_MCP_HOST_SERVICE ? registryFixtureHostMcp({ taskId: task.id, generation: task.generation,
    profileId: task.profile_id, principalId: principal.principalId }, env.MCP_TEST_AUTH_TOKEN, runtime.policy.mcp,
    env.REGISTRY_MCP_HOST_SERVICE.fetch.bind(env.REGISTRY_MCP_HOST_SERVICE)) : undefined;
  const saved = ordinaryV1 ? await store.routingSelection(task.id, task.generation) as RouteResult | null : null;
  const communicationConfig = { url: env.COMMUNICATION_API_URL, service: env.COMMUNICATION_SERVICE, token: env.COMMUNICATION_TOKEN, timeoutMs: Number(env.COMMUNICATION_TIMEOUT_MS ?? 35_000) };
  const systemHealth = async () => {
    const [runner, watcher] = await Promise.all([probeRunnerHealth(runtime.adapter), probeWatcherHealth(env)]);
    return {
      ...runner,
      watcher: watcher.watcher,
      watcherAlarmId: watcher.watcherAlarmId,
      watcherReasons: watcher.watcherReasons,
      openIncidents: watcher.watcherOpenIncidents,
      staleSources: watcher.watcherStaleSources,
    };
  };

  let result = saved ?? await routeRequest(
    {
      envelope: {
        generation: task.generation,
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
      communicationV1: ordinaryV1 ? { namesOnly: env.ROUTER_SELECTOR_NAMES_ONLY === 'true', select: communicationSelector(communicationConfig), write: communicationWriter({ ...communicationConfig, timeoutMs: Number(env.COMMUNICATION_WRITER_TIMEOUT_MS ?? 10_000) }), health: systemHealth, hostMcp } : undefined,
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
        ? await dispatchAcceptedAgent(store, port, task, result, env.ROUTER_AGENT_ENGINE?.trim() || 'opencode', hostMcp)
        : { owner: 'output', requested: true, issued: false, refusal: 'runner_not_configured' }
      : { owner: 'output', requested: true, issued: false, refusal: 'continuation_policy_disabled' }
    : await issueContinuation(result, env, store, port, body);

  if (ordinaryV1 && result.mcpRefusalCode && !result.continuation) {
    await persistMcpTaskBlock(store, task, result.mcpRefusalCode);
  }
  const taskStatus = result.mcpRefusalCode ? await store.requireTask(task.id) : null;

  return json({
    decisionId: result.decisionId,
    policyVersion: result.decision.policyVersion,
    route: result.decision.route,
    mode: result.decision.mode,
    reasonCode: result.decision.reasonCode,
    ...(result.mcpRefusalCode ? { mcpRefusalCode: result.mcpRefusalCode } : {}),
    ...(taskStatus ? { taskStatus: { status: taskStatus.status, reasonCode: taskStatus.blocker_reason ?? result.mcpRefusalCode } } : {}),
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
    setErrorPublisher(resolveErrorPublisher(env));
    const url = new URL(req.url);
const store = new TaskStore(env.DB);
     const port = workflowPortOf(env, store);
    // Проверяющая аутентификация: секрет только в binding, в запросе его нет.
    const auth = principalAuthOf(env as unknown as Record<string, string | undefined>);
     // Конфиг пилота читается из env рантайма (process.env в Workers нет).
     const intake = new IntakeService(
       store,
       new PilotRouter({ env: env as unknown as Record<string, string | undefined> }),
       ingressArtifactVerifierOf(env.INGRESS_BUFFER, env.INGRESS_BUFFER_TOKEN),
     );
    const body: Record<string, unknown> =
      req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const taskId = (body.taskId as string | undefined) ?? url.searchParams.get('taskId');

    try {
      if (url.pathname === '/healthz' || url.pathname === '/health') {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        return json({ service: 'trained-assist-control-plane', status: 'healthy', observedAt: new Date().toISOString(),
          ...(env.BUILD_SHA ? { buildSha: env.BUILD_SHA } : {}),
          ...(url.pathname === '/healthz' ? { check: 'liveness' } : {}) });
      }
      if (url.pathname === '/internal/sandbox/runner-mock-probe') {
        if (req.method !== 'POST' || env.SANDBOX_RUNNER_MOCK_PROBE_ENABLED !== 'true'
          || env.PREVIEW_ONLY === 'true' || env.PILOT_ENABLED !== 'true'
          || !String(env.PILOT_COHORT_PROFILE_IDS ?? '').split(',').map(value => value.trim()).includes('integration-telegram-ux-v1')) {
          return diagnosticsJson({ ok: false, reasonCode: 'sandbox_runner_mock_probe_unavailable' }, 404);
        }
        if (Object.keys(body).length !== 0) return diagnosticsJson({ ok: false, reasonCode: 'sandbox_runner_mock_probe_body_not_supported' }, 400);
        const principalId = await principalOf(req, auth);
        if (principalId !== 'integration-telegram-ux-v1') {
          return diagnosticsJson({ ok: false, reasonCode: principalId ? 'principal_not_allowed' : 'authentication_failed' }, principalId ? 403 : 401);
        }
        try {
          const principal = await resolvePrincipal(store, { principalId });
          requirePermission(principal, 'integration-telegram-ux-v1', 'tasks:read');
        } catch {
          return diagnosticsJson({ ok: false, reasonCode: 'principal_scope_unavailable' }, 403);
        }
        const binding = sandboxMockProbeAdapter(env);
        if (!binding.adapter) return diagnosticsJson({ ok: false, reasonCode: 'sandbox_mock_runner_binding_unavailable',
          bindingIssue: binding.bindingIssue }, 503);
        try {
          const probe = await sandboxRunnerMockProbe(binding.adapter);
          const ok = probe.state === 'succeeded' && probe.answer === 'pong' && probe.outcome === 'succeeded';
          return diagnosticsJson({ ok, check: 'authenticated_runner_mock_test', principalId,
            runId: probe.runId, runnerState: probe.state, answer: probe.answer, runnerOutcome: probe.outcome,
            sideEffects: { cpTaskCreated: false, workerOrModelCalled: false, runnerAdmissionPersisted: true },
            buildSha: env.BUILD_SHA ?? null,
          }, ok ? 200 : 502);
        } catch (error) {
          const runnerReachability = binding.runnerBaseUrl
            ? await sandboxRunnerReachability(binding.runnerBaseUrl)
            : { outcome: 'not_checked', httpStatus: null };
          return diagnosticsJson({ ok: false, reasonCode: 'sandbox_runner_mock_probe_failed',
            runnerErrorCode: sandboxRunnerProbeErrorCode(error),
            runnerErrorFields: error instanceof RunnerConflictError ? error.fieldPaths : [], runnerReachability,
            sideEffects: { cpTaskCreated: false, workerOrModelCalled: false, runnerAdmissionMayBePersisted: true },
            buildSha: env.BUILD_SHA ?? null,
          }, 503);
        }
      }
      if (url.pathname === '/internal/sandbox/readiness') {
        if (req.method !== 'GET' || env.SANDBOX_READINESS_ENABLED !== 'true'
          || env.PREVIEW_ONLY === 'false') {
          return diagnosticsJson({ ok: false, reasonCode: 'sandbox_readiness_unavailable' }, 404);
        }
        const principalId = await principalOf(req, auth);
        if (principalId !== 'integration-telegram-ux-v1') {
          return diagnosticsJson({ ok: false, reasonCode: principalId ? 'principal_not_allowed' : 'authentication_failed' }, principalId ? 403 : 401);
        }
        let principal;
        try {
          principal = await resolvePrincipal(store, { principalId });
          requirePermission(principal, 'integration-telegram-ux-v1', 'tasks:read');
          requirePermission(principal, 'integration-telegram-ux-v1', 'tasks:intake');
        } catch {
          return diagnosticsJson({ ok: false, reasonCode: 'principal_scope_unavailable' }, 403);
        }
        const profileState = await env.DB.prepare(`SELECT count(*) AS total,
          sum(CASE WHEN status NOT IN ('done','failed','cancelled') THEN 1 ELSE 0 END) AS nonterminal
          FROM durable_tasks WHERE profile_id = ?`).bind('integration-telegram-ux-v1')
          .first<{ total: number; nonterminal: number | null }>();
        const nonterminal = Number(profileState?.nonterminal ?? 0);
        return diagnosticsJson({ ok: nonterminal === 0, check: 'authenticated_sandbox_readiness',
          principalId, profileId: principal.profileId, scopes: principal.scopes,
          taskCount: Number(profileState?.total ?? 0), nonterminalTaskCount: nonterminal,
          reasonCode: nonterminal === 0 ? null : 'sandbox_lane_has_nonterminal_task',
          buildSha: env.BUILD_SHA ?? null,
        }, nonterminal === 0 ? 200 : 409);
      }
      if (url.pathname === '/internal/health/catalogue' || url.pathname === '/internal/health/summary') {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        if (!diagnosticsTokenMatches(req, env.HEALTH_DIAGNOSTICS_TOKEN)) return diagnosticsJson({ error: 'unauthorized' }, 401);
        let descriptors;
        try { descriptors = parseHealthCatalogue(env.HEALTH_CATALOGUE_JSON); }
        catch { return diagnosticsJson({ error: 'health catalogue unavailable' }, 503); }
        const environment = url.searchParams.get('environment');
        const region = url.searchParams.get('region');
        const serviceId = url.searchParams.get('serviceId');
        const filtered = descriptors.filter((item) => (!environment || item.environment === environment)
          && (!region || item.region === region) && (!serviceId || item.serviceId === serviceId));
        if (url.pathname.endsWith('/catalogue')) return diagnosticsJson({ contractVersion: 1, services: filtered });
        const timeoutMs = Number(env.HEALTH_PROBE_TIMEOUT_MS ?? '1500');
        const ttlMs = Number(env.HEALTH_CACHE_TTL_MS ?? '10000');
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000
          || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60_000) return diagnosticsJson({ error: 'health diagnostics config invalid' }, 503);
        const cacheKey = JSON.stringify([environment, region, serviceId,
          filtered.map((descriptor) => [descriptor.serviceId, descriptor.healthUrl, descriptor.readinessUrl, descriptor.deployedRevision])]);
        const now = Date.now();
        const cached = healthCatalogueCache.get(cacheKey);
        if (cached && cached.expiresAt > now) return diagnosticsJson({ contractVersion: 1, cached: true, ...cached.summary });
        const entries = await observeHealthCatalogue(filtered, { timeoutMs, concurrency: 4 });
        const statuses = entries.map((entry) => entry.observation.status);
        const status = statuses.length === 0 ? 'unknown' : statuses.includes('unhealthy') ? 'unhealthy' : statuses.includes('unknown') ? 'unknown'
          : statuses.includes('degraded') ? 'degraded' : 'healthy';
        if (cached && entries.length > 0 && statuses.every((value) => value === 'unknown')) {
          return diagnosticsJson({ contractVersion: 1, cached: true, stale: true, status: 'unknown',
            observedAt: new Date().toISOString(), sourceObservedAt: cached.summary['observedAt'],
            reasonCodes: ['stale_cache_served', ...entries.flatMap((entry) => entry.observation.reasonCodes)],
            services: cached.summary['services'] });
        }
        const summary = { status, observedAt: new Date().toISOString(), reasonCodes: entries.length ? [] : ['no_services_configured'], services: entries };
        const jitteredTtl = Math.round(ttlMs * (0.9 + Math.random() * 0.2));
        healthCatalogueCache.set(cacheKey, { expiresAt: now + jitteredTtl, summary });
        if (healthCatalogueCache.size > 64) healthCatalogueCache.clear();
        return diagnosticsJson({ contractVersion: 1, cached: false, ...summary });
      }
      if (url.pathname === '/') {
        return json({
          service: 'trained-assist-control-plane',
          endpoints: [
            '/intake',
            '/healthz',
            '/receipt',
            '/route',
            '/start',
            '/signal',
            '/cancel',
            '/status',
            '/cp-stop-targets',
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
      if (url.pathname === '/recover') {
        await authorizePrincipalScope(store, req, 'tasks:control', auth);
        return json(await port.recover());
      }

      // Маршруты попытки исполняются по runId, а не по taskId.
      if (url.pathname === '/connection-lost') {
        await authorizePrincipalScope(store, req, 'tasks:control', auth);
        const run = await port.markConnectionLost(
          body.runId as string,
          (body.reason as string | undefined) ?? 'connection_lost',
        );
        return json({ runId: run.id, status: run.status, errorClass: run.error_class, taskId: run.task_id });
      }
      if (url.pathname === '/heartbeat') {
        await authorizePrincipalScope(store, req, 'tasks:control', auth);
        const run = await port.heartbeat(body.runId as string, body.leaseSec as number | undefined);
        return json({ runId: run.id, status: run.status, leaseUntil: run.lease_until });
      }

      // Приём задачи (P04/C01): квитанция выдаётся только после durable
      // сохранения; повтор с тем же requestId возвращает прежнюю квитанцию.
       // Регистрация пакета, принятого шлюзом, ДО admitTask (arch#132 R9).
       //
       // Окно «сообщение принято накопителем, задачи ещё нет» — то самое, где
       // 2026-10-04 потерялся ввод: у накопителя есть свой таймер, и если он не
       // взведён или сломан, ввод не виден НИКОМУ. Наружу (детектору) нужен
       // след: batchId, когда пришло ПЕРВОЕ сообщение, состояние подготовки,
       // граница ожидания, адрес доставки и — после приёма — связь с задачей.
       //
       // Идемпотентно по batchId: повтор того же сообщения не передвигает
       // first_message_at, поэтому возраст самого старого непродвинувшегося ввода
       // не подменяется свежими сообщениями.
       if (url.pathname === '/intake/pending' && (req.method === 'PUT' || req.method === 'POST')) {
         const principalId = await principalOf(req, auth);
         const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
         if (!batchId || batchId.length > 200) return json({ error: 'invalid batchId' }, 400);
         const profileId = typeof body.profileId === 'string' && body.profileId.trim() ? body.profileId.trim() : null;
         if (!profileId) return json({ error: 'invalid profileId' }, 400);
         try {
           requirePermission(await resolvePrincipal(store, { principalId }), profileId, 'tasks:intake');
         } catch (e) {
           return json({ error: e instanceof Error ? e.message : 'forbidden' }, 403);
         }
         const prepState = ['collecting', 'preparing', 'ready'].includes(body.prepState as string)
           ? (body.prepState as 'collecting' | 'preparing' | 'ready') : 'collecting';
         const row = await store.recordPendingInput({
           batchId,
           version: Number.isSafeInteger(body.version) ? Number(body.version) : 1,
           profileId,
           channel: typeof body.channel === 'string' ? body.channel : 'telegram',
           conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
           audienceId: typeof body.audienceId === 'string' ? body.audienceId : null,
           destinationId: typeof body.destinationId === 'string' ? body.destinationId : null,
           // Шлюз присылает время ПЕРВОГО сообщения пакета; на повторах оно не
           // меняется — за это и отвечает recordPendingInput (первое значение
           // выигрывает, дальше двигается только счётчик).
          firstMessageAt: Number.isSafeInteger(body.firstMessageAt) ? Number(body.firstMessageAt) : Date.now(),
           deadlineMs: Number.isSafeInteger(body.deadlineMs) ? Number(body.deadlineMs) : undefined,
         });
         if (prepState !== 'collecting' && prepState !== row.prep_state) {
           await store.setPendingInputPrep(batchId, prepState);
         }
         return json({ ok: true, batchId, firstMessageAt: row.first_message_at, prepState }, 200);
       }

       // Пакет снят накопителем осознанно (запуск, отмена, /clean_buffer): детектор
       // не должен превращать решение пользователя в «зависший ввод».
       if (url.pathname === '/intake/pending/gone' && req.method === 'POST') {
         const principalId = await principalOf(req, auth);
         const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
         if (!batchId) return json({ error: 'invalid batchId' }, 400);
         const existing = await store.getPendingInput(batchId);
         if (existing) requirePermission(await resolvePrincipal(store, { principalId }), existing.profile_id, 'tasks:intake');
         const reason = ['admitted', 'launched', 'cancelled', 'cleared'].includes(body.reason as string)
           ? (body.reason as 'admitted' | 'launched' | 'cancelled' | 'cleared') : 'cancelled';
         await store.dropPendingInput(batchId, reason);
         return json({ ok: true, batchId, reason }, 200);
       }

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
        await authorizePrincipalScope(store, req, 'tasks:control', auth);
        if (!String(env.DELIVERY_ADAPTER ?? '').trim()) {
          return json({ error: 'delivery adapter not configured' }, 503);
        }
        let adapter: DeliveryAdapter;
        try {
          adapter = await resolveDeliveryAdapter(env);
        } catch {
          return json({ error: 'delivery adapter not configured' }, 503);
        }
        const owner = (body.owner as string | undefined) ?? 'local-worker';
        const result = await deliverOnce(store, owner, adapter, {
          taskId: (body.taskId as string | undefined) ?? null,
          channel: (body.channel as string | undefined) ?? null,
          maxAttempts: (body.maxAttempts as number | undefined) ?? 3,
          retryAfterSec: (body.retryAfterSec as number | undefined) ?? 0,
        });
        return result ? json(result) : json({ delivered: false, reason: 'outbox empty' });
      }
      if (url.pathname === '/runner/input-manifest') {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        const inputTaskId = url.searchParams.get('taskId');
        if (!inputTaskId) return json({ error: 'taskId is required' }, 400);
        const task = await authorizeTaskRoute(store, req, inputTaskId, 'tasks:read', auth);
        const manifest = await inputManifestForTask(task);
        return manifest ? json(manifest) : json({ error: 'input manifest not found' }, 404);
      }
      if (url.pathname === '/runner/input-artifact') {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        const inputTaskId = url.searchParams.get('taskId');
        const manifestRef = url.searchParams.get('manifestRef');
        const manifestVersion = url.searchParams.get('manifestVersion');
        const ref = url.searchParams.get('ref');
        const version = url.searchParams.get('version');
        if (!inputTaskId || !manifestRef || !manifestVersion || !ref || !version) {
          return json({ error: 'taskId, manifestRef, manifestVersion, ref and version are required' }, 400);
        }
        const task = await authorizeTaskRoute(store, req, inputTaskId, 'tasks:read', auth);
        const manifest = await inputManifestForTask(task);
        if (!manifest) return json({ error: 'input manifest not found' }, 404);
        if (manifest.manifestRef !== manifestRef || manifest.manifestVersion !== manifestVersion) {
          return json({ error: 'input manifest version mismatch' }, 409);
        }
        return await serveIngressInputArtifact(env, task, manifest, ref, version);
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
        await authorizePrincipalScope(store, req, 'tasks:read', auth);
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

      if (url.pathname === '/cp-stop-targets') {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        const parsed = cpStopTargetsInputOf(body);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const principal = await resolvePrincipal(store, { principalId: await principalOf(req, auth) });
        requirePermission(principal, parsed.input.profileId, 'tasks:control');
        const service = new CpStopTargetsService(store, port);
        return json(await service.stop(parsed.input));
      }

      if (url.pathname === '/receipt') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read', auth);
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
      if (url.pathname.startsWith('/trace/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const traceTaskId = parts[1] ?? null;
        if (!traceTaskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, traceTaskId, 'tasks:read', auth);
        const trace = await traceTask(store, traceTaskId);
        return json(trace);
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
            runnerEngine: runnerEngineOf(body.runnerEngine, env.ROUTER_AGENT_ENGINE),
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
    setErrorPublisher(resolveErrorPublisher(env));
    if (env.PREVIEW_ONLY === 'true') return;
    const store = new TaskStore(env.DB);

    // Тот же serverless Cron Trigger запускает пользовательские расписания.
    // Без profileId проход охватывает все профили; HTTP /schedules/tick
    // остаётся ограничен профилем вызывающего. Ключи occurrence и дедуп в D1
    // делают повторный вызов безопасным. Ошибка здесь не отменяет проход watchdog.
    let scheduleError: unknown;
    try {
      await scheduleServiceOf(env, store, new CfWorkflowPort(env.TASK_WORKFLOW, store)).tick();
    } catch (error) {
      scheduleError = error;
    }

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
      logError({
        event: 'intake.watchdog_scheduler_stale',
        level: 'error',
        reason: 'scheduler_not_running',
        lastAt: last?.last_run_at ?? null,
        ageMs: last ? Date.now() - last.last_run_at : null,
      });
    }

    if (scheduleError !== undefined) throw scheduleError;
  },
};
