import { isTerminalStatus, FencedError, TerminalStateError, type TaskStore, type TaskRow } from '../taskstore';
import type { CfWorkflowPort } from '../workflow-port';
import type { RouteResult } from '../router/service';

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

export async function dispatchAcceptedAgent(store: TaskStore, port: CfWorkflowPort, task: TaskRow, result: RouteResult, runnerEngine = 'opencode') {
  const current = await store.requireTask(task.id);
  if (current.generation !== task.generation) throw new FencedError(task.id, task.generation, current.generation);
  if (isTerminalStatus(current.status)) return { owner: 'output', issued: false, refusal: 'task_terminal' };
  const userValue = current.user_value ? JSON.parse(current.user_value) as Record<string, unknown> : {};
  if (userValue.gtdId) return { owner: 'output', issued: false, refusal: 'gtd_owns_continuation' };
  const runs = await store.listRuns(task.id);
  const unresolved = runs.find((run) => run.status !== 'running');
  if (unresolved) return { owner: 'output', requested: true, issued: false, refusal: 'existing_run_requires_reconciliation', runId: unresolved.id, generation: current.generation };
  const selection = result.continuation;
  if (!selection) return { owner: 'output', issued: false, refusal: 'no_agent_selection' };
  const start = await port.submit({
    id: current.id, profileId: current.profile_id, goal: current.goal,
    runnerEngine, idempotentRun: true,
    instructions: result.agentInstructions ?? selection.goal,
  });
  return { owner: 'output', issued: start.runId !== null, requested: true, runId: start.runId, generation: start.generation, jobRef: `job_${current.id}_g${start.generation}`, executor: runnerEngine };
}
