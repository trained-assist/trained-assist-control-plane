/**
 * Versioned mapping: задача control plane → RunSpec для Serverless Agent API.
 *
 * Зачем отдельный слой, а не «собрать body в adapter.submit»: контракт Runner'а
 * (`RunSpec`, `ai-agent-runner/src/contracts/run-spec.ts`) закрыт и проверяется
 * на приёме — `checkKeys` отклоняет неизвестные поля, `checkString` отклоняет
 * управляющие символы, пути выходов обязаны быть относительными. Собирать его
 * по месту нельзя: любая рассинхронизация ловится только сетевым отказом на
 * другом конце. Здесь — единственная точка сборки с версией и локальной
 * проверкой.
 *
 * Разделение владения (INV-19, C01):
 *  - ХОСТ владеет: profileId, conversationId, ownerGeneration, cwd, envAllowlist,
 *    outputs (выходной манифест), mcp (MCP bindings), repository (snapshot
 *    binding), result destination, limits. Клиент их не передаёт и не может
 *    поднять: поля отсутствуют во входном типе, а `buildRunSpec` дополнительно
 *    отклоняет их появление.
 *  - КЛИЕНТ владеет: полное сообщение (prompt) и разрешённые вложения
 *    (refs из envelope `artifactRefs`).
 *
 * Идентичность и профиль выводятся хостом из записи в Task Store, а не из
 * тела запроса: `profileId` приходит из `durable_tasks.profile_id`.
 */
import { logStructured } from '../logging/structured-log';
import type { ExecutionContextManifest } from '../router/brief/execution-context';

/** Версия mapping'а: меняется при смене формы RunSpec, а не при смене политики. */
export const RUN_SPEC_VERSION = 'run-spec-v4';

/** Версия контракта RunSpec на стороне Runner'а (RUN_SPEC_CONTRACT_VERSION). */
export const RUN_SPEC_CONTRACT_VERSION = 1;

// ── Типы контракта Runner'а (копия формы, без импорта чужого репозитория) ──

export interface EngineSpec {
  name: string;
  adapterVersion: string;
}

export interface InputRef {
  ref: string;
  version?: string;
  /**
   * Снимок workspace предыдущего рана (Runner, issue #52 шаг 1). Клиент только называет
   * снимок; байты лежат в долговечном хранилище и материализуются в workspace рана
   * с проверкой владельца и дайджеста. Без снимка поле отсутствует.
   */
  snapshotId?: string;
}

export interface OutputSpec {
  path: string;
  name?: string;
  mime?: string;
}

export interface StdioMcpServerSpec {
  serverId: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  envAllowlist?: string[];
  bindingRef?: string;
  allowedTools: string[];
  catalogueVersion?: string;
  policyVersion?: string;
  readinessTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface RemoteMcpServerSpec {
  serverId: string;
  transport: 'remote';
  url: string;
  bindingRef: string;
  /** Trusted Registry execution scope; CP never accepts it from task/model data. */
  scope?: string;
  allowedTools: string[];
  catalogueVersion?: string;
  policyVersion?: string;
  registryDigest?: string;
  toolTimeoutMs?: number;
}

export type McpServerSpec = StdioMcpServerSpec | RemoteMcpServerSpec;

export interface McpSpec {
  servers: McpServerSpec[];
}

export interface CredentialBinding {
  ref: string;
  scope: string;
  expiresAt?: string;
  status?: 'active' | 'missing' | 'expired';
}

export interface RepositorySpec {
  fullName: string;
  token?: string;
}

export interface InputManifestPin {
  manifestRef: string;
  manifestVersion: string;
}

export interface IngressManifestRef {
  contractVersion: 1;
  manifestRef: string;
  manifestVersion: string;
  userTaskId: string;
  profileId: string;
  runId: string;
  ownerGeneration: number;
}

export interface ResultPolicy {
  destinationRef?: string;
  retentionPolicy?: string;
}

export interface RunLimits {
  timeoutMs: number;
  maxOutputBytes?: number;
  maxLogBytes?: number;
}

export interface RunSpec {
  contractVersion: typeof RUN_SPEC_CONTRACT_VERSION;
  jobId: string;
  runId: string;
  operationId: string;
  userTaskId: string;
  profileId: string;
  conversationId: string;
  ownerGeneration: number;
  engine: EngineSpec;
  cwd: string;
  envAllowlist: string[];
  limits: RunLimits;
  input?: { refs?: InputRef[]; inlinePrompt?: string };
  /** Bounded task-level launch brief; Runner appends it to the accepted prompt. */
  instructions?: string;
  ingressManifest?: IngressManifestRef;
  outputs?: OutputSpec[];
  mcp?: McpSpec;
  credentialBindings?: CredentialBinding[];
  result?: ResultPolicy;
  repository?: RepositorySpec;
  traceId?: string;
}

export interface RegionConstraints {
  allowedRegions?: string[];
  dataResidency?: string;
}

export interface BudgetSpec {
  correlationRef: string;
  approved: boolean;
  reason?: string;
}

/**
 * Тело `POST /v1/runs` — ровно те ключи, которые принимает Runner
 * (`SUBMIT_KEYS` в `ai-agent-runner/src/api/contracts.ts`). Полный RunSpec туда
 * не уходит: `checkKeys` отклоняет неизвестные поля, а
 * `contractVersion/jobId/runId/operationId/profileId/ownerGeneration/cwd` Runner
 * выводит сам. Проекция явная — иначе рассинхронизация ловится только сетевым
 * отказом.
 */
export interface SubmitRequest {
  userTaskId?: string;
  conversationId?: string;
  /** Omitted when the authenticated Agent API selects from its configured engine chain. */
  engine?: EngineSpec;
  input?: { refs?: InputRef[]; inlinePrompt?: string };
  ingressManifest?: { contractVersion: 1; manifestRef: string; manifestVersion: string };
  envAllowlist: string[];
  limits: RunLimits;
  deadline?: string;
  regionConstraints?: RegionConstraints;
  credentialBindings?: CredentialBinding[];
  budget?: BudgetSpec;
  result?: ResultPolicy;
  outputs?: OutputSpec[];
  mcp?: McpSpec;
  traceId?: string;
  instructions?: string;
  repository?: RepositorySpec;
}

/**
 * Проекция RunSpec → тело `POST /v1/runs`.
 *
 * MCP-серверы проецируются в закрытый API-контракт. CP-only metadata (`scope`,
 * `registryDigest`) остаётся в host policy и не уходит в Agent API; там remote
 * binding разрешается по trusted `bindingRef` и API-side конфигурации. Значения
 * секретов в request не передаются. Поля, которые Runner выводит сам, перечислены
 * в `untransmittedRunSpecFields`.
 */
function mcpSubmitSpecOf(mcp: McpSpec): McpSpec {
  return {
    servers: mcp.servers.map((server) => server.transport === 'remote'
      ? {
          serverId: server.serverId,
          transport: 'remote',
          url: server.url,
          bindingRef: server.bindingRef,
          allowedTools: server.allowedTools,
          ...(server.policyVersion !== undefined ? { policyVersion: server.policyVersion } : {}),
          ...(server.catalogueVersion !== undefined ? { catalogueVersion: server.catalogueVersion } : {}),
          ...(server.toolTimeoutMs !== undefined ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
        }
      : {
          serverId: server.serverId,
          transport: 'stdio',
          command: server.command,
          ...(server.args !== undefined ? { args: server.args } : {}),
          ...(server.envAllowlist !== undefined ? { envAllowlist: server.envAllowlist } : {}),
          ...(server.bindingRef !== undefined ? { bindingRef: server.bindingRef } : {}),
          allowedTools: server.allowedTools,
          ...(server.catalogueVersion !== undefined ? { catalogueVersion: server.catalogueVersion } : {}),
          ...(server.policyVersion !== undefined ? { policyVersion: server.policyVersion } : {}),
          ...(server.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: server.readinessTimeoutMs } : {}),
          ...(server.toolTimeoutMs !== undefined ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
        }),
  };
}

export function toSubmitRequest(spec: RunSpec, options: { engineSelection?: 'caller' | 'agent_api' } = {}): SubmitRequest {
  const body: SubmitRequest = {
    envAllowlist: spec.envAllowlist,
    limits: spec.limits,
  };
  if (options.engineSelection !== 'agent_api') body.engine = spec.engine;
  if (spec.userTaskId) body.userTaskId = spec.userTaskId;
  if (spec.conversationId) body.conversationId = spec.conversationId;
  if (spec.input) body.input = spec.input;
  if (spec.instructions) body.instructions = spec.instructions;
  if (spec.ingressManifest) body.ingressManifest = {
    contractVersion: spec.ingressManifest.contractVersion,
    manifestRef: spec.ingressManifest.manifestRef,
    manifestVersion: spec.ingressManifest.manifestVersion,
  };
  if (spec.outputs) body.outputs = spec.outputs;
  if (spec.repository) body.repository = spec.repository;
  if (spec.result) body.result = spec.result;
  if (spec.mcp) body.mcp = mcpSubmitSpecOf(spec.mcp);
  if (spec.traceId) body.traceId = spec.traceId;
  if (spec.credentialBindings) body.credentialBindings = spec.credentialBindings;
  return body;
}

/** Поля RunSpec, которые контракт submit не переносит (для лога и отчёта). */
export function untransmittedRunSpecFields(spec: RunSpec): string[] {
  const fields: string[] = [];
  for (const key of ['contractVersion', 'jobId', 'runId', 'operationId', 'profileId', 'ownerGeneration', 'cwd'] as const) {
    fields.push(key);
  }
  return fields;
}

// ── Вход и политика ────────────────────────────────────────────────────────

/** Клиентская часть входа: только сообщение и разрешённые вложения. */
export interface RunSpecInput {
  userTaskId: string;
  /** Профиль-владелец: из записи в Task Store, не из тела запроса. */
  profileId: string;
  conversationId: string | null;
  /** Поколение попытки: fencing (INV-02). */
  ownerGeneration: number;
  engineName: string;
  /** Полное сообщение задачи (goal control plane). */
  prompt: string;
  /** Разрешённые вложения: `artifactRefs` из envelope приёма. */
  refs: InputRef[];
  inputManifest?: InputManifestPin | null;
  instructions: string | null;
  /** Внутренний runId попытки control plane — корреляция (traceId). */
  attemptRunId: string | null;
  timeoutMs: number;
}

/**
 * Хостовая политика исполнения. Клиенту не передаётся и не переопределяется:
 * читается из bindings окружения воркера (секреты — только SM/GitHub Secrets).
 */
export interface RunSpecPolicy {
  inputRefs?: InputRef[];
  timeoutMs?: number;
  startupTimeoutMs?: number;
  cwd: string;
  envAllowlist: string[];
  outputs: OutputSpec[];
  mcp: McpSpec | null;
  repository: RepositorySpec | null;
  resultDestinationRef: string | null;
  maxOutputBytes: number | null;
  maxLogBytes?: number | null;
}

export interface BuiltRunSpec {
  spec: RunSpec;
  version: typeof RUN_SPEC_VERSION;
  /** true, если управляющие символы в prompt пришлось нормализовать. */
  promptNormalized: boolean;
  runId: string;
  jobId: string;
  operationId: string;
}

export class RunSpecMappingError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'RunSpecMappingError';
  }
}

// ── Политика по умолчанию из bindings окружения ────────────────────────────

const DEFAULT_CWD = '/workspace';
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPOSITORY_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const PROMPT_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const MAX_MCP_URL_CHARS = 2000;
const MAX_MCP_BINDING_REF_CHARS = 300;
const MAX_MCP_TOOL_TIMEOUT_MS = 120_000;
const REMOTE_MCP_SERVER_KEYS = new Set([
  'serverId',
  'transport',
  'url',
  'bindingRef',
  'scope',
  'allowedTools',
  'toolTimeoutMs',
  'catalogueVersion',
  'policyVersion',
  'registryDigest',
]);

function readJson<T>(raw: string | undefined, fallback: T, field: string): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RunSpecMappingError(`${field}: expected a JSON value`, field);
  }
}

/**
 * Политика из env рантайма. Значения по умолчанию — минимальные и
 * непривилегированные: без envAllowlist, без MCP, без репозитория, без
 * объявленных выходов. Расширение — только явным решением владельца в
 * bindings, никогда со стороны клиента.
 */
/**
 * Политика по умолчанию: минимальная и непривилегированная. Используется, когда
 * хост не задал политнику в bindings (локальные прогоны, тесты).
 */
export function defaultRunSpecPolicy(): RunSpecPolicy {
  return {
    cwd: DEFAULT_CWD,
    envAllowlist: [],
    outputs: [],
    mcp: null,
    repository: null,
    resultDestinationRef: null,
    maxOutputBytes: null,
  };
}

export function runSpecPolicyOf(env: Record<string, string | undefined>): RunSpecPolicy {
  if (env.RUN_SPEC_POLICY_PROFILE && env.RUN_SPEC_POLICY_PROFILE !== 'integration-v1') {
    throw new RunSpecMappingError('RUN_SPEC_POLICY_PROFILE: unsupported host policy', 'RUN_SPEC_POLICY_PROFILE');
  }
  const cwd = env.RUN_SPEC_CWD?.trim() || DEFAULT_CWD;
  if (!cwd.startsWith('/')) throw new RunSpecMappingError('RUN_SPEC_CWD: expected an absolute path', 'RUN_SPEC_CWD');

  const envAllowlist = (env.RUN_SPEC_ENV_ALLOWLIST ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of envAllowlist) {
    if (!ENV_NAME.test(name)) throw new RunSpecMappingError(`RUN_SPEC_ENV_ALLOWLIST: "${name}" is not an env NAME`, 'RUN_SPEC_ENV_ALLOWLIST');
  }

  const outputs = readJson<OutputSpec[]>(env.RUN_SPEC_OUTPUTS, [], 'RUN_SPEC_OUTPUTS');
  const mcp = readJson<McpSpec | null>(env.RUN_SPEC_MCP, null, 'RUN_SPEC_MCP');
  const repository = readJson<RepositorySpec | null>(env.RUN_SPEC_REPOSITORY,
    env.RUN_SPEC_POLICY_PROFILE === 'integration-v1' ? { fullName: 'trained-assist/ai-agent-runner' } : null,
    'RUN_SPEC_REPOSITORY');

  const timeoutMs = Number(env.RUN_SPEC_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RunSpecMappingError(`RUN_SPEC_TIMEOUT_MS: expected 1..${MAX_TIMEOUT_MS}`, 'RUN_SPEC_TIMEOUT_MS');
  }

  const startupTimeoutMs = Number(env.RUN_SPEC_STARTUP_TIMEOUT_MS ?? (env.RUN_SPEC_POLICY_PROFILE === 'integration-v1' ? 600_000 : 0));
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 0 || startupTimeoutMs > MAX_TIMEOUT_MS) {
    throw new RunSpecMappingError(`RUN_SPEC_STARTUP_TIMEOUT_MS: expected 0..${MAX_TIMEOUT_MS}`, 'RUN_SPEC_STARTUP_TIMEOUT_MS');
  }

  const maxOutputBytes = env.RUN_SPEC_MAX_OUTPUT_BYTES ? Number(env.RUN_SPEC_MAX_OUTPUT_BYTES) : null;
  if (maxOutputBytes !== null && (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
    throw new RunSpecMappingError('RUN_SPEC_MAX_OUTPUT_BYTES: expected a positive integer', 'RUN_SPEC_MAX_OUTPUT_BYTES');
  }
  const maxLogBytes = env.RUN_SPEC_MAX_LOG_BYTES ? Number(env.RUN_SPEC_MAX_LOG_BYTES) : null;
  if (maxLogBytes !== null && (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0)) {
    throw new RunSpecMappingError('RUN_SPEC_MAX_LOG_BYTES: expected a positive safe integer', 'RUN_SPEC_MAX_LOG_BYTES');
  }

  return {
    cwd,
    inputRefs: readJson<InputRef[]>(env.RUN_SPEC_INPUT_REFS, [], 'RUN_SPEC_INPUT_REFS'),
    ...(env.RUN_SPEC_TIMEOUT_MS || env.RUN_SPEC_POLICY_PROFILE === 'integration-v1' ? { timeoutMs } : {}),
    ...(env.RUN_SPEC_STARTUP_TIMEOUT_MS || env.RUN_SPEC_POLICY_PROFILE === 'integration-v1' ? { startupTimeoutMs } : {}),
    envAllowlist,
    outputs,
    mcp,
    repository,
    resultDestinationRef: env.RUN_SPEC_RESULT_DESTINATION_REF?.trim() || null,
    maxOutputBytes,
    ...(maxLogBytes !== null ? { maxLogBytes } : {}),
  };
}

// ── Сборка ─────────────────────────────────────────────────────────────────

/**
 * Собрать RunSpec из клиентского входа и хостовой политики.
 *
 * Хостовые поля, найденные во входе, — ошибка отображения, а не «клиент не
 * прав»: так нельзя случайно расширить права при добавлении полей во
 * входной тип.
 */
export function buildRunSpec(input: RunSpecInput, policy: RunSpecPolicy): BuiltRunSpec {
  const fail = (field: string, message: string): never => {
    throw new RunSpecMappingError(message, field);
  };

  if ('mcp' in input) {
    fail('mcp', 'mcp: host-owned field must not come from the client input');
  }

  if (!SAFE_ID.test(input.userTaskId)) fail('userTaskId', 'userTaskId: expected a safe id');
  if (input.profileId.length === 0 || input.profileId.length > 200) fail('profileId', 'profileId: expected 1..200 chars');
  if (input.conversationId !== null && (input.conversationId.length === 0 || input.conversationId.length > 200)) {
    fail('conversationId', 'conversationId: expected 1..200 chars or null');
  }
  // Контракт Runner'а требует непустой conversationId. У headless-задачи его
  // нет — хост выводит стабильный scope из userTaskId (не из тела запроса).
  const conversationId = input.conversationId ?? `task:${input.userTaskId}`;
  if (!Number.isInteger(input.ownerGeneration) || input.ownerGeneration < 0) fail('ownerGeneration', 'ownerGeneration: expected a non-negative integer');
  if (input.engineName.length === 0 || input.engineName.length > 100) fail('engineName', 'engineName: expected 1..100 chars');
  if (input.prompt.trim().length === 0) fail('prompt', 'prompt: must not be empty');
  const inlinePrompt = input.prompt;
  if (inlinePrompt.length > 100_000) fail('prompt', 'prompt: longer than 100000');
  if (PROMPT_CONTROL_CHARS.test(inlinePrompt)) fail('prompt', 'prompt: unsupported control characters');
  const instructions = input.instructions?.trim() || undefined;
  if (instructions && instructions.length > 10_000) fail('instructions', 'instructions: longer than Runner limit 10000');
  if (instructions && PROMPT_CONTROL_CHARS.test(instructions)) fail('instructions', 'instructions: unsupported control characters');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) fail('timeoutMs', 'timeoutMs: expected a positive integer');

  // Разрешённые вложения: только строковые ref'ы, без версионирования со стороны
  // клиента — версию вправе назначить только хост (snapshot binding).
  const refs: InputRef[] = [];
  if (policy.inputRefs !== undefined && !Array.isArray(policy.inputRefs)) fail('inputRefs', 'host inputRefs: expected an array');
  for (const [index, ref] of [...(policy.inputRefs ?? []), ...input.refs].entries()) {
    if (typeof ref?.ref !== 'string' || ref.ref.length === 0 || ref.ref.length > 500) {
      fail(`refs[${index}]`, `refs[${index}].ref: expected 1..500 chars`);
    }
    if (ref.version !== undefined && (typeof ref.version !== 'string' || ref.version.length > 200)) {
      fail(`refs[${index}]`, `refs[${index}].version: expected 1..200 chars`);
    }
    if (ref.snapshotId !== undefined) {
      if (typeof ref.snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref.snapshotId)) {
        fail(`refs[${index}]`, `refs[${index}].snapshotId: expected an id matching [A-Za-z0-9][A-Za-z0-9._:-]*`);
      }
      if (ref.snapshotId.length > 200) fail(`refs[${index}]`, `refs[${index}].snapshotId: expected 1..200 chars`);
    }
    const out: InputRef = { ref: ref.ref };
    if (ref.version !== undefined) out.version = ref.version;
    if (ref.snapshotId !== undefined) out.snapshotId = ref.snapshotId;
    refs.push(out);
  }

  const promptNormalized = false;

  const runId = `run_${input.userTaskId.replace(/[^A-Za-z0-9._:-]/g, '_')}_${input.ownerGeneration}`;
  const jobId = `job_${input.userTaskId.replace(/[^A-Za-z0-9._:-]/g, '_')}`;
  const operationId = `op_${input.attemptRunId ?? runId}`;
  if (input.inputManifest) {
    if (refs.length > 0) fail('inputManifest', 'ingress manifest cannot be combined with other input refs');
    if (input.inputManifest.manifestRef !== `cp-input-manifest:${input.userTaskId}`) fail('inputManifest.manifestRef', 'expected the task-scoped Control Plane manifest ref');
    if (!/^[0-9a-f]{64}$/.test(input.inputManifest.manifestVersion)) fail('inputManifest.manifestVersion', 'expected lowercase sha256');
  }

  const spec: RunSpec = {
    contractVersion: RUN_SPEC_CONTRACT_VERSION,
    jobId,
    runId,
    operationId,
    userTaskId: input.userTaskId,
    profileId: input.profileId,
    conversationId,
    ownerGeneration: input.ownerGeneration,
    engine: { name: input.engineName, adapterVersion: '1' },
    cwd: policy.cwd,
    envAllowlist: [...policy.envAllowlist],
    limits: {
      timeoutMs: policy.timeoutMs ?? input.timeoutMs,
      ...(policy.maxOutputBytes ? { maxOutputBytes: policy.maxOutputBytes } : {}),
      ...(policy.maxLogBytes ? { maxLogBytes: policy.maxLogBytes } : {}),
    },
    input: {
      ...(inlinePrompt ? { inlinePrompt } : {}),
      ...(refs.length ? { refs } : {}),
    },
    ...(instructions ? { instructions } : {}),
    ...(input.inputManifest ? { ingressManifest: {
      contractVersion: 1,
      manifestRef: input.inputManifest.manifestRef,
      manifestVersion: input.inputManifest.manifestVersion,
      userTaskId: input.userTaskId,
      profileId: input.profileId,
      runId,
      ownerGeneration: input.ownerGeneration,
    } } : {}),
    ...(policy.outputs.length ? { outputs: policy.outputs } : {}),
    ...(policy.mcp ? { mcp: policy.mcp } : {}),
    ...(policy.repository ? { repository: policy.repository } : {}),
    ...(policy.resultDestinationRef ? { result: { destinationRef: policy.resultDestinationRef } } : {}),
    ...(input.attemptRunId ? { traceId: input.attemptRunId } : {}),
  };

  const validation = validateRunSpec(spec);
  if (!validation.ok) fail('spec', `built RunSpec is rejected by the Runner contract: ${validation.errors.join('; ')}`);

  return { spec, version: RUN_SPEC_VERSION, promptNormalized, runId, jobId, operationId };
}

function isSafeBindingRef(value: unknown): boolean {
  return (
    typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_MCP_BINDING_REF_CHARS
    && !CONTROL_CHARS.test(value)
  );
}

function remoteMcpUrlErrors(url: unknown, path: string): string[] {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_MCP_URL_CHARS) {
    return [`${path}: expected an absolute HTTPS URL of 1..${MAX_MCP_URL_CHARS} chars`];
  }
  if (CONTROL_CHARS.test(url)) return [`${path}: unsupported control characters`];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [`${path}: expected an absolute HTTPS URL`];
  }
  const errors: string[] = [];
  if (parsed.protocol !== 'https:') errors.push(`${path}: expected HTTPS`);
  if (parsed.hostname.length === 0) errors.push(`${path}: expected a nonempty hostname`);
  if (parsed.username.length > 0 || parsed.password.length > 0) errors.push(`${path}: must not carry credentials`);
  if (parsed.search.length > 0) errors.push(`${path}: must not carry a query`);
  if (parsed.hash.length > 0) errors.push(`${path}: must not carry a fragment`);
  return errors;
}

// ── Локальная проверка по контракту Runner'а ───────────────────────────────
//
// Контракт опубликован (SERVERLESS-AGENT-API.md, RunSpec); импортировать чужой
// репозиторий нельзя, поэтому проверка продублирована здесь в объёме полей,
// которые производит этот mapping. Расхождение с валидатором Runner'а ловится
// локально, а не сетевым отказом.

export function validateRunSpec(spec: RunSpec): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const safeId = (value: unknown, path: string): boolean =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && SAFE_ID.test(value) ? true : (errors.push(`${path}: expected a safe id`), false);

  for (const key of ['jobId', 'runId', 'operationId'] as const) safeId(spec[key], `spec.${key}`);
  for (const key of ['userTaskId', 'profileId', 'conversationId'] as const) {
    const value = spec[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) errors.push(`spec.${key}: expected 1..200 chars`);
  }
  if (spec.contractVersion !== RUN_SPEC_CONTRACT_VERSION) errors.push(`spec.contractVersion: expected ${RUN_SPEC_CONTRACT_VERSION}`);
  if (!Number.isInteger(spec.ownerGeneration) || spec.ownerGeneration < 0) errors.push('spec.ownerGeneration: expected a non-negative integer');

  const engine = spec.engine;
  if (typeof engine !== 'object' || engine === null) {
    errors.push('spec.engine: expected an object');
  } else {
    if (typeof engine.name !== 'string' || engine.name.length === 0 || engine.name.length > 100) errors.push('spec.engine.name: expected 1..100 chars');
    if (typeof engine.adapterVersion !== 'string' || engine.adapterVersion.length === 0 || engine.adapterVersion.length > 100) {
      errors.push('spec.engine.adapterVersion: expected 1..100 chars');
    }
  }

  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0 || !spec.cwd.startsWith('/')) errors.push('spec.cwd: expected an absolute path');
  if (!Array.isArray(spec.envAllowlist)) {
    errors.push('spec.envAllowlist: expected an array');
  } else {
    spec.envAllowlist.forEach((name, i) => {
      if (!ENV_NAME.test(name)) errors.push(`spec.envAllowlist[${i}]: expected an env NAME (no values)`);
    });
  }

  const limits = spec.limits;
  if (typeof limits !== 'object' || limits === null) {
    errors.push('spec.limits: expected an object');
  } else {
    if (!Number.isInteger(limits.timeoutMs) || (limits.timeoutMs as number) <= 0) errors.push('spec.limits.timeoutMs: expected a positive integer');
    for (const key of ['maxOutputBytes', 'maxLogBytes'] as const) {
      const value = limits[key];
      if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) errors.push(`spec.limits.${key}: expected a positive integer`);
    }
  }

  const input = spec.input;
  if (input !== undefined) {
    if (typeof input !== 'object' || input === null) {
      errors.push('spec.input: expected an object');
    } else {
      if (input.inlinePrompt !== undefined) {
        if (typeof input.inlinePrompt !== 'string' || input.inlinePrompt.length === 0) errors.push('spec.input.inlinePrompt: expected a non-empty string');
        else if (input.inlinePrompt.length > 100_000) errors.push('spec.input.inlinePrompt: longer than 100000');
        else if (PROMPT_CONTROL_CHARS.test(input.inlinePrompt)) errors.push('spec.input.inlinePrompt: unsupported control characters');
      }
      if (input.refs !== undefined) {
        if (!Array.isArray(input.refs)) errors.push('spec.input.refs: expected an array');
        else {
          input.refs.forEach((ref, i) => {
            if (typeof ref !== 'object' || ref === null) {
              errors.push(`spec.input.refs[${i}]: expected an object`);
              return;
            }
            if (typeof ref.ref !== 'string' || ref.ref.length === 0 || ref.ref.length > 500) errors.push(`spec.input.refs[${i}].ref: expected 1..500 chars`);
            if (ref.version !== undefined && (typeof ref.version !== 'string' || ref.version.length > 200)) errors.push(`spec.input.refs[${i}].version: expected 1..200 chars`);
          });
        }
      }
    }
  }

  if (spec.ingressManifest !== undefined) {
    const manifest = spec.ingressManifest;
    if (manifest.contractVersion !== 1) errors.push('spec.ingressManifest.contractVersion: expected 1');
    if (manifest.manifestRef !== `cp-input-manifest:${spec.userTaskId}`) errors.push('spec.ingressManifest.manifestRef: expected task-scoped manifest ref');
    if (!/^[0-9a-f]{64}$/.test(manifest.manifestVersion)) errors.push('spec.ingressManifest.manifestVersion: expected lowercase sha256');
    if (manifest.userTaskId !== spec.userTaskId) errors.push('spec.ingressManifest.userTaskId: must match spec.userTaskId');
    if (manifest.profileId !== spec.profileId) errors.push('spec.ingressManifest.profileId: must match spec.profileId');
    if (manifest.runId !== spec.runId) errors.push('spec.ingressManifest.runId: must match spec.runId');
    if (manifest.ownerGeneration !== spec.ownerGeneration) errors.push('spec.ingressManifest.ownerGeneration: must match spec.ownerGeneration');
    if ((spec.input?.refs?.length ?? 0) > 0) errors.push('spec.input.refs: cannot be combined with spec.ingressManifest');
  }

  if (spec.instructions !== undefined) {
    if (typeof spec.instructions !== 'string' || spec.instructions.length === 0) errors.push('spec.instructions: expected a non-empty string');
    else if (spec.instructions.length > 10_000) errors.push('spec.instructions: longer than 10000');
    else if (PROMPT_CONTROL_CHARS.test(spec.instructions)) errors.push('spec.instructions: unsupported control characters');
  }

  if (spec.outputs !== undefined) {
    if (!Array.isArray(spec.outputs)) {
      errors.push('spec.outputs: expected an array');
    } else {
      const seen = new Set<string>();
      spec.outputs.forEach((output, i) => {
        if (typeof output !== 'object' || output === null) {
          errors.push(`spec.outputs[${i}]: expected an object`);
          return;
        }
        if (typeof output.path !== 'string' || output.path.length === 0) {
          errors.push(`spec.outputs[${i}].path: expected a non-empty string`);
        } else if (output.path.startsWith('/') || output.path === '.' || output.path === '..' || output.path.split('/').includes('..')) {
          errors.push(`spec.outputs[${i}].path: expected a relative path inside the run workspace`);
        } else if (seen.has(output.path)) {
          errors.push(`spec.outputs[${i}].path: duplicate output path "${output.path}"`);
        }
        seen.add(output.path);
        if (output.name !== undefined && (typeof output.name !== 'string' || output.name.length === 0 || output.name.length > 200)) {
          errors.push(`spec.outputs[${i}].name: expected 1..200 chars`);
        }
        if (output.mime !== undefined && (typeof output.mime !== 'string' || output.mime.length === 0 || output.mime.length > 100)) {
          errors.push(`spec.outputs[${i}].mime: expected 1..100 chars`);
        }
      });
    }
  }

  if (spec.mcp !== undefined) {
    if (typeof spec.mcp !== 'object' || spec.mcp === null || !Array.isArray(spec.mcp.servers) || spec.mcp.servers.length === 0) {
      errors.push('spec.mcp.servers: expected a non-empty array');
    } else {
      const toolOwner = new Map<string, string>();
      const serverIds = new Set<string>();
      if (spec.mcp.servers.some((server) => server?.transport === 'remote')) {
        for (const key of Object.keys(spec.mcp)) {
          if (key !== 'servers') errors.push('spec.mcp: unsupported field for remote metadata');
        }
      }
      spec.mcp.servers.forEach((server, i) => {
        const path = `spec.mcp.servers[${i}]`;
        if (typeof server !== 'object' || server === null) {
          errors.push(`${path}: expected an object`);
          return;
        }
        if (!SAFE_ID.test(server.serverId)) errors.push(`${path}.serverId: expected a safe id`);
        else if (serverIds.has(server.serverId)) errors.push(`${path}.serverId: duplicate server id "${server.serverId}"`);
        else serverIds.add(server.serverId);

        if (!Array.isArray(server.allowedTools) || server.allowedTools.length === 0) {
          errors.push(`${path}.allowedTools: at least one tool is required`);
        } else {
          server.allowedTools.forEach((tool, j) => {
            if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) {
              errors.push(`${path}.allowedTools[${j}]: expected a tool name`);
              return;
            }
            const owner = toolOwner.get(tool);
            if (owner !== undefined) errors.push(`${path}.allowedTools[${j}]: tool "${tool}" is already declared by server "${owner}"`);
            else toolOwner.set(tool, server.serverId);
          });
        }

        if (server.transport === 'remote') {
          if (server.scope !== undefined && (typeof server.scope !== 'string' || !SAFE_ID.test(server.scope))) errors.push(`${path}.scope: expected a safe scope identifier`);
          if (server.catalogueVersion !== undefined && (typeof server.catalogueVersion !== 'string' || !SAFE_ID.test(server.catalogueVersion))) errors.push(`${path}.catalogueVersion: expected a safe version identifier`);
          if (server.policyVersion !== undefined && (typeof server.policyVersion !== 'string' || !SAFE_ID.test(server.policyVersion))) errors.push(`${path}.policyVersion: expected a safe version identifier`);
          if (server.registryDigest !== undefined && (typeof server.registryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(server.registryDigest))) errors.push(`${path}.registryDigest: expected a lowercase SHA-256 hex digest`);
          if (!isSafeBindingRef(server.bindingRef)) {
            errors.push(`${path}.bindingRef: expected 1..${MAX_MCP_BINDING_REF_CHARS} chars without control characters`);
          }
          if (Array.isArray(server.allowedTools) && server.allowedTools.length > 50) {
            errors.push(`${path}.allowedTools: at most 50 tools are allowed`);
          }
          if (server.toolTimeoutMs !== undefined && (!Number.isInteger(server.toolTimeoutMs) || server.toolTimeoutMs <= 0 || server.toolTimeoutMs > MAX_MCP_TOOL_TIMEOUT_MS)) {
            errors.push(`${path}.toolTimeoutMs: expected an integer in [1, ${MAX_MCP_TOOL_TIMEOUT_MS}]`);
          }
          for (const key of Object.keys(server)) {
            if (!REMOTE_MCP_SERVER_KEYS.has(key)) {
              errors.push(`${path}.${key}: unsupported field for transport "remote"`);
            }
          }
          errors.push(...remoteMcpUrlErrors(server.url, `${path}.url`));
          return;
        }
        if (server.transport !== 'stdio') {
          errors.push(`${path}.transport: expected "stdio" or "remote"`);
          return;
        }
        if (typeof server.command !== 'string' || server.command.length === 0 || server.command.length > 512) errors.push(`${path}.command: expected 1..512 chars`);
        if (server.envAllowlist !== undefined) {
          if (!Array.isArray(server.envAllowlist)) errors.push(`${path}.envAllowlist: expected an array`);
          else server.envAllowlist.forEach((name, j) => {
            if (!ENV_NAME.test(name)) errors.push(`${path}.envAllowlist[${j}]: expected an env NAME`);
          });
        }
      });
    }
  }

  if (spec.credentialBindings !== undefined) {
    if (!Array.isArray(spec.credentialBindings)) {
      errors.push('spec.credentialBindings: expected an array');
    } else {
      spec.credentialBindings.forEach((binding, i) => {
        const path = `spec.credentialBindings[${i}]`;
        if (typeof binding !== 'object' || binding === null) {
          errors.push(`${path}: expected an object`);
          return;
        }
        if (typeof binding.ref !== 'string' || binding.ref.length === 0 || binding.ref.length > 300) errors.push(`${path}.ref: expected 1..300 chars`);
        if (typeof binding.scope !== 'string' || binding.scope.length === 0 || binding.scope.length > 300) errors.push(`${path}.scope: expected 1..300 chars`);
      });
    }
  }

  if (spec.repository !== undefined) {
    const repo = spec.repository;
    if (typeof repo !== 'object' || repo === null) {
      errors.push('spec.repository: expected an object');
    } else {
      if (typeof repo.fullName !== 'string' || !REPOSITORY_FULL_NAME.test(repo.fullName)) errors.push('spec.repository.fullName: expected "owner/name"');
      if (repo.token !== undefined && (typeof repo.token !== 'string' || repo.token.length === 0 || repo.token.length > 500)) {
        errors.push('spec.repository.token: expected 1..500 chars');
      }
    }
  }

  if (spec.result !== undefined) {
    const result = spec.result;
    if (typeof result !== 'object' || result === null) {
      errors.push('spec.result: expected an object');
    } else {
      if (result.destinationRef !== undefined && (typeof result.destinationRef !== 'string' || result.destinationRef.length === 0 || result.destinationRef.length > 300)) {
        errors.push('spec.result.destinationRef: expected 1..300 chars');
      }
      if (result.retentionPolicy !== undefined && (typeof result.retentionPolicy !== 'string' || result.retentionPolicy.length === 0 || result.retentionPolicy.length > 100)) {
        errors.push('spec.result.retentionPolicy: expected 1..100 chars');
      }
    }
  }

  if (spec.traceId !== undefined && (typeof spec.traceId !== 'string' || spec.traceId.length === 0 || spec.traceId.length > 200)) {
    errors.push('spec.traceId: expected 1..200 chars');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Событие о нормализации prompt: факт виден, а не молчалив. */
export function logRunSpecBuilt(fields: {
  profileId: string;
  userTaskId: string;
  runId: string;
  version: string;
  promptNormalized: boolean;
  refs: number;
  outputs: number;
  mcpServers: number;
  /** Всегда false: `mcp` переносится в тело submit вместе с остальным RunSpec. */
  mcpNotTransmitted?: boolean;
  /** Поля RunSpec, которые Runner выводит сам и в submit не передаются. */
  untransmitted?: string[];
  /** Safe launch manifest only; no user prompt or brief text. */
  executionContext?: ExecutionContextManifest | null;
  reason?: string;
}): void {
  logStructured({
    event: 'run_spec.built',
    profileId: fields.profileId,
    userTaskId: fields.userTaskId,
    runId: fields.runId,
    reason: fields.reason ?? 'mapped',
    version: fields.version,
    promptNormalized: fields.promptNormalized,
    refs: fields.refs,
    outputs: fields.outputs,
    mcpServers: fields.mcpServers,
    ...(fields.mcpNotTransmitted === undefined ? {} : { mcpNotTransmitted: fields.mcpNotTransmitted }),
    ...(fields.untransmitted ? { untransmitted: fields.untransmitted } : {}),
    ...(fields.executionContext ? { executionContext: fields.executionContext } : {}),
  });
}
