import type { TaskReplyMcp, TaskReplyTool } from './task-reply-mcp';
import { isCapabilityAllowed, isIntegrationAllowed } from './authorization';
import { sandboxCapabilityCatalog } from './catalog';
import { agentWorkOrder } from './handlers';
import { buildScopedBrief } from './brief/service';
import { buildExecutionContext } from './brief/execution-context';
import { initialSelectorDecision } from './policy';
import { SelectorError, type IntentSelection } from './communication-client';
import type { RouteResult } from './service';
import type { CapabilityCatalog, PreparedInput, RoutingInput } from './router-types';
import type { TaskRow, TaskStore } from '../taskstore';
import { isTerminalStatus } from '../taskstore';
import { McpCatalogueError, mcpReasonCode, requiresMcpRevalidation } from './mcp-catalogue';
import type { McpCatalogueScope, McpCatalogueSnapshot, SelectedMcpInstruction } from './mcp-catalogue-types';
import { sameMcpScope, validateHostMcpExecution, type HostMcpRoutingDeps } from './host-mcp-routing';

export const COMMUNICATION_V1_VERSION = 'communication-v1';

export function communicationV1Catalog(tools: TaskReplyTool[] = []): CapabilityCatalog {
  const catalog = sandboxCapabilityCatalog();
  const names = new Set(tools.map(tool => tool.name));
  return { version: `${catalog.version}:${COMMUNICATION_V1_VERSION}`, capabilities: [
    ...catalog.capabilities.filter(entry => !names.has(entry.id)),
    ...tools.map(tool => ({
      id: tool.name, version: 1, title: tool.description, aliases: [tool.name],
      dataSource: 'none' as const, effect: 'none' as const, integrationId: null, requiredInputs: [], routeHint: 'deterministic' as const,
      supportedModes: ['deterministic' as const], preferredMode: 'deterministic' as const, templateId: null,
      handlerRef: `mcp:${tool.name}`,
    })),
  ] };
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

function savedConversationMessage(author: string, value: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
  } catch { /* Older rows may store plain text. */ }
  if (!parsed) return value;

  if (author === 'user' && Array.isArray(parsed.inputItems)) {
    const messages = parsed.inputItems.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text : typeof record.caption === 'string' ? record.caption : '';
      const refs = Array.isArray(record.artifactRefs) ? record.artifactRefs : [];
      const parts = [text, ...(refs.length ? [`Вложения: ${refs.map(ref => typeof ref === 'string' ? ref : JSON.stringify(ref)).join(', ')}`] : [])].filter(Boolean);
      return parts.length ? [parts.join('\n')] : [];
    });
    const topLevelRefs = Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs : [];
    if (topLevelRefs.length) messages.push(`Вложения: ${topLevelRefs.map(ref => typeof ref === 'string' ? ref : JSON.stringify(ref)).join(', ')}`);
    const supplemental = Object.fromEntries(Object.entries(parsed).filter(([key]) =>
      !['inputItems', 'artifactRefs', 'pilotRoute', 'pilotReason'].includes(key)));
    if (Object.keys(supplemental).length) messages.push(`Дополнительные данные ввода: ${JSON.stringify(supplemental)}`);
    return messages.join('\n');
  }

  if (author === 'assistant' && typeof parsed.answer === 'string') {
    const supplemental = Object.fromEntries(Object.entries(parsed).filter(([key]) =>
      !['answer', 'engineText', 'userAnswer', 'version', 'mode', 'answerSource', 'runId', 'ownerGeneration', 'attempt', 'persistence', 'exitReason'].includes(key)));
    return [parsed.answer, ...(Object.keys(supplemental).length ? [`Дополнительные результаты: ${JSON.stringify(supplemental)}`] : [])].join('\n');
  }

  return JSON.stringify(parsed, null, 2);
}

const AGENT_INSTRUCTIONS_BUDGET = 8_500;

function compactInstructionText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '\n[… середина сообщения сокращена …]\n';
  const side = Math.floor((limit - marker.length) / 2);
  return `${value.slice(0, side)}${marker}${value.slice(-side)}`;
}

export function agentConversationInstructions(input: Pick<PreparedInput, 'text' | 'originalInput' | 'durableContext'> & { agentGoalSummary?: string | null }): string {
  const history = input.durableContext ?? { history: [], active_tasks: [] };
  const parts: string[] = [];
  if (input.text.trim()) {
    // The complete current request is also Runner's `input.prompt`. Duplicating
    // a large request in `instructions` can violate Runner's independent 10k
    // instruction limit before a run is admitted.
    parts.push(input.text.length <= 1_600
      ? `Текущий исходный ввод пользователя (сохраняй формулировку и все ограничения):\n${input.text}`
      : 'Полный текущий запрос передан отдельно как входная задача; соблюдай его формулировку и ограничения.');
  }
  if (input.originalInput !== undefined) {
    const original = JSON.stringify(input.originalInput);
    parts.push(original.length <= 1_200
      ? `Полный исходный принятый ввод, включая структуру и ссылки на вложения:\n${original}`
      : 'Структура и вложения переданы отдельно вместе с задачей.');
  }
  if (input.agentGoalSummary?.trim()) {
    parts.push(`Предварительная формулировка задачи от маршрутизатора (недоверенная подсказка только для понимания намерения; исходный запрос пользователя имеет приоритет):\n${compactInstructionText(input.agentGoalSummary.trim(), 1_200)}`);
  }
  const base = parts.join('\n\n');
  const historyBlocks = history.history.map((entry) => {
    const role = entry.author === 'assistant' ? 'Ассистент' : 'Пользователь';
    const message = compactInstructionText(savedConversationMessage(entry.author, entry.text), 1_800);
    return `${role} (задача ${entry.id.split(':')[0]}):\n${message}`;
  });
  const activeTasks = history.active_tasks.slice(-5).map((task) =>
    `- ${task.id}: ${compactInstructionText(task.goal, 300)}`);
  const activeBlock = activeTasks.length ? `Другие незавершённые задачи этой беседы:\n${activeTasks.join('\n')}` : '';
  const header = historyBlocks.length ? 'Полный сохранённый контекст диалога для continuation: недавние реплики целиком, в хронологическом порядке.' : '';
  const fixed = [base, activeBlock].filter(Boolean).join('\n\n');
  const selected: string[] = [];
  let size = fixed.length + (header ? header.length + 2 : 0);
  for (let index = historyBlocks.length - 1; index >= 0; index -= 1) {
    const block = historyBlocks[index]!;
    const added = block.length + (selected.length ? 2 : 0);
    // Reserve room for the omission marker, added after the retained suffix is known.
    if (size + added + 120 > AGENT_INSTRUCTIONS_BUDGET) break;
    selected.unshift(block);
    size += added;
  }
  const omitted = historyBlocks.length - selected.length;
  const transcript = selected.length
    ? `${header}\n${omitted ? `[${omitted} более ранних реплик опущено из-за лимита инструкций.]\n` : ''}${selected.join('\n\n')}`
    : (omitted ? `[${omitted} более ранних реплик опущено из-за лимита инструкций.]` : '');
  const result = [fixed, transcript].filter(Boolean).join('\n\n');
  return result.length <= AGENT_INSTRUCTIONS_BUDGET
    ? result
    : compactInstructionText(result, AGENT_INSTRUCTIONS_BUDGET);
}

export interface CommunicationV1Deps {
  taskReplies?: TaskReplyMcp;
  hostMcp?: HostMcpRoutingDeps;
  namesOnly?: boolean;
  select: (input: Record<string, unknown>) => Promise<IntentSelection>;
}

export async function routeCommunicationV1(input: RoutingInput, deps: CommunicationV1Deps): Promise<RouteResult> {
  const startedAt = Date.now();
  const decision = initialSelectorDecision(input);
  decision.policyVersion = COMMUNICATION_V1_VERSION;
  decision.decisionId = `${input.envelope.userTaskId}:${input.envelope.requestId}:${COMMUNICATION_V1_VERSION}`;
  let allowed: Array<TaskReplyTool & { id: string }> = [];
  let mcpReply: string | undefined;
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
    if (!deps.taskReplies) throw new SelectorError('mcp_not_configured');
    allowed = (await deps.taskReplies.list()).filter(tool => isCapabilityAllowed(input.authorization, tool.name)).map(tool => ({ ...tool, id: tool.name }));
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
      recipient: snapshot ? { role: 'Выбери точный id quick answer или имя зарегистрированного метода из списка; если ничего не подходит — no_matching_option.' }
        : { role: 'Ты сам — помощник trained-assist и система, к которой пользователь обращается в этом диалоге.', persona: 'Выбери один метод MCP, только если он целиком покрывает запрос. Составные запросы и продолжения работы передавай агенту целиком.' },
      decision_options: snapshot ? [
        ...allowed.map(({ id }) => ({ id })),
        ...snapshot.decisionOptions,
      ]
        : deps.namesOnly ? [...allowed.map(({ id }) => ({ id })), { id: 'agent' }] : [...allowed.map(({ id, description }) => ({ id, description })),
        { id: 'agent', description: 'Выполнить любую задачу, не покрытую целиком одним доступным quick answer; сохранить все подзадачи и ограничения.', applicability: 'Составные запросы, работа с файлами, внешние действия, непонятные запросы и продолжения задач. Если один опубликованный MCP-метод полностью покрывает самостоятельный запрос, выбирай этот метод.' }],
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
    } else if (allowed.some(answer => answer.id === result.decision)) {
      selected = result.decision;
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
    if (selected !== 'agent') {
      const tool = allowed.find(entry => entry.id === selected)!;
      mcpReply = await deps.taskReplies.call(tool, `${decision.decisionId}:mcp`, {
        catalog: { version: input.catalog.version, entries: visible.map(entry => ({ id: entry.id, title: entry.title,
          availability: entry.integrationId ? (isIntegrationAllowed(input.authorization, entry.integrationId) ? 'granted_readiness_unverified' : 'not_connected') : 'registered' })) },
        authorizationRef: input.authorization.snapshotRef,
      });
    }
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
        : 'Каталог MCP недоступен; выполнен маршрут MCP-ответа без агентских MCP-инструментов.'
      : failure?.startsWith('mcp_') ? 'Вызов MCP недоступен; исходная задача передана агенту.' : 'Определение маршрута недоступно; исходная задача передана агенту.', actions: [] } : null;
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
      const brief = await buildScopedBrief(input, { purpose: 'agent-work-order' });
      if (brief.status !== 'ok' || !brief.brief) {
        decision.needsExecutor = false;
        decision.executor = null;
        decision.outcome = 'technical_error';
        decision.reasonCode = brief.status === 'over_budget' ? 'BRIEF_BUDGET_EXCEEDED' : 'BRIEF_METADATA_INVALID';
        decision.replyAllowed = false;
      } else {
        const selectedCapabilityIds: string[] = [];
        const executionContext = buildExecutionContext({
          decisionId: decision.decisionId,
          suggestedGoal: workOrder.goal,
          originalRequestRef: workOrder.originalRequestRef,
          reasonCode: decision.reasonCode,
          hostConstraints: workOrder.preservedConstraints,
          modelPreservedConstraints: [],
          selectedCapabilityIds,
          requiresConfirmation: workOrder.requiresConfirmation,
          catalogBrief: brief.brief,
        });
        continuation = { ...workOrder, decisionId: decision.decisionId, reasonCode: decision.reasonCode,
          partialResultRef: null, selectedCapabilityIds, executionContext, workOrder };
      }
    }
  } else {
    decision.route = 'deterministic';
    decision.mode = 'deterministic-handler';
    decision.capabilityId = selected;
    decision.capabilityVersion = 1;
    decision.replyAllowed = true;
    decision.outcome = 'reply';
    reply = { text: mcpReply!, evidenceRefs: [`mcp:tools/call:${selected}:${decision.decisionId}`, input.authorization.snapshotRef], mode: 'deterministic-handler' };
    decision.capabilityExecutions = 1;
    decision.firstUsefulReplyMs = Date.now() - startedAt;
  }
  let rendering: RouteResult['rendering'];
  if (reply) {
    rendering = { source: 'deterministic', failure: null };
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
