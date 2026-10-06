import { isTerminalStatus, FencedError, TerminalStateError, type TaskStore, type TaskRow } from '../taskstore';
import type { CfWorkflowPort } from '../workflow-port';
import type { RouteResult } from '../router/service';
import { runMcpDescriptor, type HostMcpRoutingDeps } from '../router/host-mcp-routing';
import { McpCatalogueError, mcpReasonCode, requiresMcpRevalidation } from '../router/mcp-catalogue';

export interface DispatchAcceptedAgentResult {
  owner: 'output';
  issued: boolean;
  requested?: boolean;
  refusal?: string;
  reasonCode?: string;
  runId?: string | null;
  generation?: number;
  jobRef?: string;
  executor?: string;
}

function mcpRefusalCode(code: string): string {
  return requiresMcpRevalidation(code) || code === 'mcp_scope_changed' ? 'MCP_REVALIDATION_REQUIRED' : code;
}

export async function persistMcpTaskBlock(store: TaskStore, task: TaskRow, reasonCode: string): Promise<void> {
  const current = await store.requireTask(task.id);
  if (current.generation !== task.generation) throw new FencedError(task.id, task.generation, current.generation);
  if (isTerminalStatus(current.status)) return;
  await store.commit(task.id, task.generation, {
    status: 'blocked', stage: 'handing_off', step: 'output', source: 'output', blockerReason: reasonCode,
    result: { ok: false, status: 'blocked', reasonCode,
      message: reasonCode === 'MCP_REVALIDATION_REQUIRED'
        ? 'Требуется повторная проверка каталога MCP и политики доступа. Агент не запущен.'
        : `Проверка MCP завершилась отказом (${reasonCode}). Агент не запущен.` },
    payload: { reasonCode, userVisible: true },
  });
}

async function refuseMcpDispatch(store: TaskStore, task: TaskRow, result: RouteResult, rawCode: string): Promise<DispatchAcceptedAgentResult> {
  const reasonCode = mcpRefusalCode(rawCode);
  result.mcpRefusalCode = reasonCode;
  result.decision.reasonCode = mcpReasonCode(rawCode);
  result.decision.outcome = 'blocked';
  result.decision.needsExecutor = false;
  result.decision.executor = null;
  result.decision.escalation = 'none';
  result.decision.degraded = true;
  result.decision.degradedNotice = { text: reasonCode === 'MCP_REVALIDATION_REQUIRED'
    ? 'Каталог MCP или доверенная политика изменились; требуется повторная проверка. Агент не запущен.'
    : 'Проверка MCP отказала; агент не запущен.', actions: [] };
  await persistMcpTaskBlock(store, task, reasonCode);
  return { owner: 'output', requested: true, issued: false, refusal: reasonCode, reasonCode };
}

export async function commitQuickAnswer(store: TaskStore, task: TaskRow, result: RouteResult): Promise<void> {
  if (!result.reply) return;
  try {
    await store.commit(task.id, task.generation, {
      status: 'done', stage: 'finished', source: 'output',
      result: { ok: true, answer: result.reply.text, mode: 'quick_answer', version: 'communication-v1',
        quickAnswer: { id: result.decision.capabilityId, version: result.decision.capabilityVersion }, evidenceRefs: result.reply.evidenceRefs, rendering: result.rendering },
      payload: { decisionId: result.decisionId, capabilityId: result.decision.capabilityId, capabilityVersion: result.decision.capabilityVersion, evidenceRefs: result.reply.evidenceRefs },
    });
  } catch (error) {
    if (!(error instanceof TerminalStateError)) throw error;
    const current = await store.requireTask(task.id);
    if (current.status !== 'done' || current.result_json === null) throw error;
  }
}

export async function dispatchAcceptedAgent(store: TaskStore, port: CfWorkflowPort, task: TaskRow, result: RouteResult, runnerEngine = 'opencode', hostMcp?: HostMcpRoutingDeps): Promise<DispatchAcceptedAgentResult> {
  const current = await store.requireTask(task.id);
  if (current.generation !== task.generation) throw new FencedError(task.id, task.generation, current.generation);
  if (isTerminalStatus(current.status)) return { owner: 'output', issued: false, refusal: 'task_terminal' };
  // A previous submit may already have an authoritative run receipt. Reconcile
  // that attempt before revalidating pre-launch MCP policy: a later catalogue
  // outage must not rewrite an admitted run as "agent not started".
  const runs = await store.listRuns(task.id);
  if (runs.length > 0) {
    const existing = runs.find((run) => run.status !== 'running') ?? runs[runs.length - 1]!;
    return { owner: 'output', requested: true, issued: false, refusal: 'existing_run_requires_reconciliation', runId: existing.id, generation: current.generation };
  }
  let mcpDescriptor;
  if (result.mcpInstruction) {
    const scope = result.mcpInstruction.scope;
    if (scope.taskId !== current.id || scope.profileId !== current.profile_id || scope.generation !== current.generation) {
      return refuseMcpDispatch(store, current, result, 'mcp_scope_changed');
    }
    try { mcpDescriptor = await runMcpDescriptor(hostMcp, result.mcpInstruction); }
    catch (error) {
      return refuseMcpDispatch(store, current, result,
        error instanceof McpCatalogueError ? error.code : 'execution_state_unavailable');
    }
  }
  const userValue = current.user_value ? JSON.parse(current.user_value) as Record<string, unknown> : {};
  if (userValue.gtdId) return { owner: 'output', issued: false, refusal: 'gtd_owns_continuation' };
  const selection = result.continuation;
  if (!selection) return { owner: 'output', issued: false, refusal: 'no_agent_selection' };
  const start = await port.submit({
    id: current.id, profileId: current.profile_id, goal: current.goal,
    runnerEngine, idempotentRun: true,
    instructions: result.agentInstructions ?? selection.goal,
    mcpDescriptor,
  });
  return { owner: 'output', issued: start.runId !== null, requested: true, runId: start.runId, generation: start.generation, jobRef: `job_${current.id}_g${start.generation}`, executor: runnerEngine };
}
