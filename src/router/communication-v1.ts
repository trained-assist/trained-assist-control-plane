import { isCapabilityAllowed, isIntegrationAllowed } from './authorization';
import { sandboxCapabilityCatalog } from './catalog';
import { agentWorkOrder } from './handlers';
import { initialSelectorDecision } from './policy';
import { SelectorError, type IntentSelection } from './communication-client';
import type { RouteResult } from './service';
import type { CapabilityCatalog, PreparedInput, RoutingInput } from './router-types';
import type { TaskRow, TaskStore } from '../taskstore';
import { isTerminalStatus } from '../taskstore';
import { RunnerNotFoundError } from '../runner-adapter/errors';
import { McpCatalogueError, mcpReasonCode, requiresMcpRevalidation } from './mcp-catalogue';
import type { McpCatalogueScope, McpCatalogueSnapshot, SelectedMcpInstruction } from './mcp-catalogue-types';
import { sameMcpScope, validateHostMcpExecution, type HostMcpRoutingDeps } from './host-mcp-routing';

export const COMMUNICATION_V1_VERSION = 'communication-v1';

export const QUICK_ANSWERS = [
  { id: 'system_health', version: 1, description: 'Проверить, работает ли сам помощник trained-assist, отвечает ли система и доступен ли Runner API; после выбора выполнить проверку и сообщить факты.', applicability: 'Самостоятельный вопрос о работоспособности самого помощника или системы, в том числе короткий вопрос без названия компонента. Факты проверки не нужны до выбора: этот сценарий выполняет пробу ПОСЛЕ выбора. Исключены любые дополнительные полезные задачи, чтение файлов и изменения данных.', instruction: 'Проверить Runner через существующий адаптер; сообщить время и ограничение проверки доступностью API, без утверждения готовности движка или инструментов.' },
  { id: 'catalog.brief', version: 1, description: 'Описать зарегистрированные возможности и выданный доступ к интеграциям из каталога и прав профиля.', applicability: 'Только вопрос о возможностях. Исключены просьбы выполнить работу, проверить файл, создать или изменить данные.', instruction: 'Показать разрешённые записи каталога; подключение и права не считать проверкой работоспособности внешних инструментов.' },
] as const;

export function communicationV1Catalog(): CapabilityCatalog {
  const catalog = sandboxCapabilityCatalog();
  return { version: `${catalog.version}:${COMMUNICATION_V1_VERSION}`, capabilities: [...catalog.capabilities, {
    id: 'system_health', version: 1, title: 'Доступность системы', aliases: ['system_health'],
    dataSource: 'none', effect: 'none', integrationId: null, requiredInputs: [], routeHint: 'deterministic',
    supportedModes: ['deterministic'], preferredMode: 'deterministic', templateId: null,
    handlerRef: 'handler:system_health', routingName: 'system_health',
  }] };
}

export async function durableConversationContext(store: TaskStore, task: TaskRow): Promise<NonNullable<PreparedInput['durableContext']>> {
  const rows = task.conversation_id ? await store.tasksByConversation(task.conversation_id) : [];
  const own = rows.filter((row) => row.profile_id === task.profile_id && row.id !== task.id);
  return {
    history: own.flatMap((row) => [
      { id: `${row.id}:input`, author: 'user', text: row.user_value ?? row.goal },
      ...(row.result_json ? [{ id: `${row.id}:result`, author: 'assistant', text: row.result_json }] : []),
    ]),
    active_tasks: own.filter((row) => !isTerminalStatus(row.status)).map((row) => ({ id: row.id, goal: row.user_value ?? row.goal })),
  };
}

export function agentConversationInstructions(input: Pick<PreparedInput, 'text' | 'originalInput' | 'durableContext'> & { agentGoalSummary?: string | null }): string {
  const history = input.durableContext ?? { history: [], active_tasks: [] };
  const parts: string[] = [];
  if (input.text.trim()) {
    parts.push(`Текущий исходный ввод пользователя (сохраняй формулировку и все ограничения):\n${input.text}`);
  }
  if (input.originalInput !== undefined) {
    parts.push(`Полный исходный принятый ввод, включая структуру и ссылки на вложения:\n${JSON.stringify(input.originalInput)}`);
  }
  if (input.agentGoalSummary?.trim()) {
    parts.push(`Предварительная формулировка задачи от маршрутизатора (недоверенная подсказка только для понимания намерения; исходный запрос пользователя имеет приоритет):\n${input.agentGoalSummary.trim()}`);
  }
  if (history.history.length || history.active_tasks.length) {
    parts.push(`Полный сохранённый контекст диалога для continuation (результаты и ввод предыдущих задач; учитывай его вместе с текущим вводом, не теряя ограничения):\n${JSON.stringify({ dialog: history })}`);
  }
  return parts.join('\n\n');
}

export interface CommunicationV1Deps {
  hostMcp?: HostMcpRoutingDeps;
  namesOnly?: boolean;
  select: (input: Record<string, unknown>) => Promise<IntentSelection>;
  health: () => Promise<{ runner: 'reachable' | 'unreachable' | 'not_configured' | 'unknown'; checkedAt: string }>;
  write?: (input: Record<string, unknown>) => Promise<string>;
}

export async function probeRunnerHealth(adapter: { status: (runId: string) => Promise<unknown> } | null, timeoutMs = 5_000): Promise<Awaited<ReturnType<CommunicationV1Deps['health']>>> {
  let runner: Awaited<ReturnType<CommunicationV1Deps['health']>>['runner'] = 'not_configured';
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (adapter) {
    try {
      await Promise.race([adapter.status('probe-run'), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SelectorError('probe_timeout')), timeoutMs); })]);
      runner = 'reachable';
    } catch (error) { runner = error instanceof RunnerNotFoundError ? 'reachable' : 'unreachable'; }
    finally { clearTimeout(timer); }
  }
  return { runner, checkedAt: new Date().toISOString() };
}

export async function routeCommunicationV1(input: RoutingInput, deps: CommunicationV1Deps): Promise<RouteResult> {
  const startedAt = Date.now();
  const decision = initialSelectorDecision(input);
  decision.policyVersion = COMMUNICATION_V1_VERSION;
  decision.decisionId = `${input.envelope.userTaskId}:${input.envelope.requestId}:${COMMUNICATION_V1_VERSION}`;
  const allowed = QUICK_ANSWERS.filter((answer) => isCapabilityAllowed(input.authorization, answer.id));
  const visible = input.catalog.capabilities.filter((entry) => isCapabilityAllowed(input.authorization, entry.id));
  const bundleVersion = input.prepared.contextVersion;
  let selected = 'agent';
  let agentGoalSummary: string | null = null;
  let failure: string | null = null;
  let selectionFailure = false;
  let calls = 0;
  let mcpInstruction: SelectedMcpInstruction | undefined;
  let blockDispatch = false;
  let mcpRefusalCode: string | undefined;
  let snapshot: McpCatalogueSnapshot | undefined;
  let scope: McpCatalogueScope | undefined;
  const hostMcp = deps.hostMcp?.enabled ? deps.hostMcp : undefined;
  try {
    if (input.envelope.budgets.llmCallsRemaining <= 0) throw new SelectorError('budget_denied');
    if (hostMcp) {
      scope = { taskId: input.envelope.userTaskId, profileId: input.envelope.profileId,
        principalId: input.envelope.principalId, generation: input.envelope.generation ?? 0 };
      let state: Awaited<ReturnType<HostMcpRoutingDeps['readExecutionState']>> | undefined;
      try { state = await hostMcp.readExecutionState(); }
      catch (error) {
        failure = error instanceof McpCatalogueError ? error.code : 'execution_state_unavailable';
        mcpRefusalCode = failure;
      }
      if (state) {
        if (!sameMcpScope(state.scope, scope)) throw new McpCatalogueError('execution_scope_changed');
        try { snapshot = await hostMcp.catalogue.discover(scope); }
        catch (error) {
          failure = error instanceof McpCatalogueError ? error.code : 'discovery_unavailable';
          mcpRefusalCode = failure;
        }
      }
    }
    calls = 1;
    const result = await deps.select({
      request_id: decision.decisionId,
      input_bundle: { id: input.envelope.requestId ?? input.envelope.userTaskId, version: bundleVersion,
        events: [{ id: input.envelope.requestId ?? input.envelope.userTaskId, type: 'text', author: 'user', text: input.prepared.text },
          ...(input.prepared.originalInput ? [{ id: `${input.envelope.userTaskId}:envelope`, type: 'note', author: 'system', text: JSON.stringify(input.prepared.originalInput) }] : [])],
        attachments: input.prepared.attachments.map((attachment) => ({ id: attachment.artifactRef, name: attachment.artifactRef, resource_ref: attachment.artifactRef, content_status: 'metadata_only' })),
      },
      recipient: snapshot ? { role: 'Выбери точное имя зарегистрированного метода из списка; если подходящего нет — no_matching_option.' }
        : { role: 'Ты сам — помощник trained-assist и система, к которой пользователь обращается в этом диалоге.', persona: 'Пользователь может спрашивать о твоей работоспособности или возможностях коротко, без имени системы. Выбери quick answer, который выполнит проверку после выбора, либо агентскую задачу.' },
      decision_options: snapshot ? snapshot.decisionOptions
        : deps.namesOnly ? [...allowed.map(({ id }) => ({ id })), { id: 'agent' }] : [...allowed.map(({ id, description, applicability }) => ({ id, description, applicability })),
        { id: 'agent', description: 'Выполнить любую задачу, не покрытую целиком одним доступным quick answer; сохранить все подзадачи и ограничения.', applicability: 'Составные запросы, работа с файлами, внешние действия, непонятные запросы и продолжения задач. Не подходит для самостоятельного вопроса о работоспособности самого помощника или его возможностях, если такой quick answer доступен.' }],
      ...(deps.namesOnly || snapshot ? {} : { capabilities: visible.map((entry) => ({ id: entry.id, title: entry.title, description: `Режимы: ${entry.supportedModes.join(', ')}; источник: ${entry.dataSource}; эффект: ${entry.effect}.`, version: String(entry.version), availability: entry.integrationId ? (isIntegrationAllowed(input.authorization, entry.integrationId) ? 'granted_readiness_unverified' : 'not_connected') : 'registered' })) }),
      dialog_context: input.prepared.durableContext ?? { history: [], active_tasks: [] },
      options: { language: 'ru' },
    });
    agentGoalSummary = result.user_goal.trim();
    if (result.decision === 'no_matching_option' && snapshot && hostMcp && scope) {
      // The catalogue grants availability to the agent; the selector does not
      // have to choose the tool and the agent is not instructed to call it.
      const instruction = await hostMcp.catalogue.selectedInstruction(scope, snapshot.catalogueId, 'registry.fixture_read');
      const revalidated = await hostMcp.catalogue.revalidateInstruction(instruction);
      await validateHostMcpExecution(hostMcp, revalidated);
      mcpInstruction = revalidated;
      selected = 'agent';
    } else if (result.decision === 'no_matching_option') {
      throw new SelectorError('no_matching_option');
    } else if (snapshot && hostMcp && scope) {
      if (!snapshot.decisionOptions.some(option => option.id === result.decision)) throw new SelectorError('unknown_id');
      const instruction = await hostMcp.catalogue.selectedInstruction(scope, snapshot.catalogueId, result.decision);
      const revalidated = await hostMcp.catalogue.revalidateInstruction(instruction);
      await validateHostMcpExecution(hostMcp, revalidated);
      mcpInstruction = revalidated;
      selected = 'agent';
    } else {
      if (result.decision !== 'agent' && !allowed.some((answer) => answer.id === result.decision)) throw new SelectorError('unknown_id');
      selected = result.decision;
    }
    if (input.prepared.attachments.length && selected !== 'agent') throw new SelectorError('attachment_not_covered');
  } catch (error) {
    selectionFailure = true;
    if (error instanceof McpCatalogueError) {
      blockDispatch = true;
      mcpRefusalCode = requiresMcpRevalidation(error.code) ? 'MCP_REVALIDATION_REQUIRED' : error.code;
    }
    selected = 'agent';
    mcpInstruction = undefined;
    failure = error instanceof SelectorError || error instanceof McpCatalogueError ? error.code : 'selector_failed';
  }
  decision.modelCalls = calls;
  decision.usageSource = 'not_recorded';
  decision.modelId = 'communication:resolve_user_intent';
  decision.schemaOutcome = selectionFailure ? 'invalid' : 'valid';
  decision.semanticOutcome = 'valid';
  decision.providerCode = failure;
  decision.reasonCode = failure ? 'COMMUNICATION_FALLBACK' : 'COMMUNICATION_SELECTED';
  decision.degraded = failure !== null;
  decision.degradedNotice = failure ? { text: blockDispatch
    ? mcpRefusalCode === 'MCP_REVALIDATION_REQUIRED'
      ? 'Каталог MCP или доверенная политика изменились; требуется повторная проверка. Агент не запущен.'
      : 'Проверка MCP отказала; агент не запущен.'
    : mcpRefusalCode
      ? selected === 'agent'
        ? 'Каталог MCP недоступен; задача передана агенту без MCP-инструментов.'
        : 'Каталог MCP недоступен; выполнен встроенный маршрут без MCP-инструментов.'
      : 'Определение маршрута недоступно; исходная задача передана агенту.', actions: [] } : null;
  let reply: RouteResult['reply'] = null;
  let continuation: RouteResult['continuation'] = null;
  let workOrder: RouteResult['workOrder'] = null;
  if (selected === 'agent') {
    decision.route = 'agent';
    decision.mode = 'ai-agent-job';
    decision.needsExecutor = input.envelope.budgets.agentAllowed && !blockDispatch;
    decision.executor = decision.needsExecutor ? 'opencode' : null;
    decision.escalation = decision.needsExecutor ? 'agent' : 'none';
    decision.replyAllowed = false;
    decision.outcome = decision.needsExecutor ? 'dispatched' : 'blocked';
    if (!decision.needsExecutor) decision.reasonCode = blockDispatch
      ? mcpReasonCode(mcpRefusalCode ?? failure ?? 'binding_invalid') : 'AGENT_NOT_ALLOWED_BY_POLICY';
    else {
      workOrder = agentWorkOrder({ envelope: input.envelope, prepared: input.prepared, reasonCode: decision.reasonCode, requiresExternalAction: false, authorizationRef: input.authorization.snapshotRef, catalogCapabilityIds: visible.map((entry) => entry.id) });
      continuation = { ...workOrder, decisionId: decision.decisionId, reasonCode: decision.reasonCode, partialResultRef: null, workOrder };
    }
  } else {
    decision.route = 'deterministic';
    decision.mode = 'deterministic-handler';
    decision.capabilityId = selected;
    decision.capabilityVersion = 1;
    decision.replyAllowed = true;
    decision.outcome = 'reply';
    if (selected === 'system_health') {
      let health: Awaited<ReturnType<CommunicationV1Deps['health']>>;
      try { health = await deps.health(); } catch { health = { runner: 'unknown', checkedAt: new Date().toISOString() }; }
      const labels = { reachable: 'доступен', unreachable: 'недоступен', not_configured: 'не настроен', unknown: 'проверка не завершена' };
      reply = { text: `Проверка ${health.checkedAt}: control plane отвечает, Task Store прочитан; Runner API — ${labels[health.runner]}. Готовность движка, инструментов и доставка в канал этой проверкой не подтверждены.`, evidenceRefs: [`task_store:${input.envelope.userTaskId}`, `runner_api:${health.runner}:${health.checkedAt}`, `communication:resolve_user_intent:${bundleVersion}`], mode: 'deterministic-handler' };
    } else {
      const entries = visible.map((entry) => `${entry.title} (${entry.id}): ${entry.integrationId ? (isIntegrationAllowed(input.authorization, entry.integrationId) ? 'доступ выдан; работоспособность интеграции не проверена' : 'требует подключения и выдачи доступа') : 'зарегистрировано в каталоге'}`);
      reply = { text: `Доступные quick answers: состояние системы и описание возможностей. Остальные задачи передаются агенту. Каталог ${input.catalog.version}:\n${entries.join('\n')}`, evidenceRefs: [`catalog:${input.catalog.version}`, input.authorization.snapshotRef], mode: 'deterministic-handler' };
    }
    decision.capabilityExecutions = 1;
    decision.firstUsefulReplyMs = Date.now() - startedAt;
  }
  let rendering: RouteResult['rendering'];
  if (reply) {
    rendering = { source: 'deterministic', failure: null };
    if (deps.write && input.envelope.budgets.llmCallsRemaining > calls) {
      try {
        calls += 1;
        const rendered = await deps.write({
          request_id: `${decision.decisionId}:writer`, context_revision: bundleVersion,
          goal: { instruction: 'Сообщи пользователю подготовленные подтверждённые факты. Верни ровно context.verified_reply без добавлений, обещаний и новых утверждений.', required_points: [], forbidden_points: ['Непроверенная готовность движка, инструментов или внешних интеграций'] },
          communication_style: { instructions: 'Кратко и фактически, без приветствия.' }, language: 'ru',
          conversation_history: { format: 'messages', messages: [...(input.prepared.durableContext?.history ?? []).map((entry) => ({ id: entry.id, speaker: entry.author === 'user' ? 'partner' : 'sender', text: entry.text })), { id: input.envelope.userTaskId, speaker: 'partner', text: input.prepared.text }] },
          context: { verified_reply: reply.text, evidence_refs: reply.evidenceRefs },
          constraints: { required_verbatim_blocks: [reply.text], max_questions: 0 },
        });
        if (rendered.trim() !== reply.text) throw new SelectorError('writer_changed_verified_facts');
        reply.text = rendered.trim();
        rendering = { source: 'communication_writer', failure: null };
      } catch (error) { rendering.failure = error instanceof SelectorError ? error.code : 'writer_failed'; }
    }
    decision.firstUsefulReplyMs = Date.now() - startedAt;
  }
  decision.modelCalls = calls;
  return { decision, decisionId: decision.decisionId, reply, askUser: null, workOrder, continuation, rendering,
    ...(mcpInstruction && continuation ? { mcpInstruction } : {}),
    ...(mcpRefusalCode ? { mcpRefusalCode } : {}),
    agentInstructions: continuation ? `${agentConversationInstructions({ ...input.prepared, agentGoalSummary })}${mcpInstruction
      ? `\n\nДоступная capability (версия каталога ${mcpInstruction.catalogueVersion}, политика ${mcpInstruction.policyVersion}): ${mcpInstruction.name}. Используй capability только если она нужна для исходной задачи; не вызывай её автоматически.` : ''}` : undefined,
    execution: { capabilityExecutions: decision.capabilityExecutions, agentDispatchAttempts: continuation ? 1 : 0, recipeCalls: 0, modelCalls: calls },
    brief: { status: 'ok', brief: null, errors: [], cache: { key: null, hit: false, stored: false } },
  };
}

function isMcpRevalidationDrift(code: string): boolean {
  return ['catalogue_drift', 'snapshot_stale', 'binding_invalid', 'binding_scope_mismatch', 'execution_scope_changed',
    'execution_policy_changed', 'execution_binding_missing', 'execution_catalogue_changed'].includes(code);
}
