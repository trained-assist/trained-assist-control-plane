import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { FencedError, TaskStore, TerminalStateError } from './taskstore';
import {
  CfWorkflowPort,
  cfStepCtx,
  conversationPlan,
  type PlanOutcome,
  type PlanParams,
  type SubmitInput,
} from './workflow-port';
import { IntakeService } from './intake';
import { EnvelopeConflictError, PrincipalForbiddenError, PrincipalUnauthorizedError } from './intake/errors';
import { InvalidEnvelopeError } from './intake/envelope';

export interface Env {
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
}

const isPermanent = (e: unknown): boolean =>
  e instanceof FencedError ||
  e instanceof TerminalStateError ||
  /fenced|terminal state/i.test(String((e as Error)?.message ?? e));

export class TaskWorkflow extends WorkflowEntrypoint<Env, PlanParams> {
  override async run(event: WorkflowEvent<PlanParams>, step: WorkflowStep): Promise<PlanOutcome> {
    const store = new TaskStore(this.env.DB);
    try {
      if (!event.payload?.taskId || typeof event.payload.generation !== 'number') {
        throw new NonRetryableError(
          `invalid plan params: ${JSON.stringify({ taskId: event.payload?.taskId, generation: event.payload?.generation })}`,
        );
      }
      return await conversationPlan(cfStepCtx(step), store, event.payload);
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

const errorStatus = (e: unknown): number => {
  if (e instanceof InvalidEnvelopeError) return 400;
  if (e instanceof PrincipalUnauthorizedError) return 401;
  if (e instanceof PrincipalForbiddenError) return 403;
  if (e instanceof EnvelopeConflictError) return 409;
  if (e instanceof FencedError || e instanceof TerminalStateError) return 409;
  return 500;
};

const principalOf = (req: Request): string | null => req.headers.get('x-principal');

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
    const port = new CfWorkflowPort(env.TASK_WORKFLOW, store);
    const intake = new IntakeService(store);
    const body: Record<string, unknown> =
      req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const taskId = (body.taskId as string | undefined) ?? url.searchParams.get('taskId');

    try {
      if (url.pathname === '/') {
        return json({
          service: 'trained-assist-control-plane',
          endpoints: ['/intake', '/receipt', '/start', '/signal', '/cancel', '/status', '/recover'],
        });
      }
      if (url.pathname === '/recover') return json(await port.recover());

      // Приём задачи (P04/C01): квитанция выдаётся только после durable
      // сохранения; повтор с тем же requestId возвращает прежнюю квитанцию.
      if (url.pathname === '/intake') {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        const result = await intake.admit({ principalId: principalOf(req) ?? '' }, body);
        return json(
          {
            receiptId: result.receipt.receiptId,
            requestId: result.receipt.requestId,
            userTaskId: result.userTaskId,
            profileId: result.receipt.profileId,
            acceptedAt: result.receipt.acceptedAt,
            durable: true,
            duplicate: result.duplicate,
          },
          result.duplicate ? 200 : 201,
        );
      }
      if (url.pathname === '/receipt') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        const receipt = await store.acceptReceipt(taskId);
        if (!receipt) return json({ error: 'receipt not found' }, 404);
        return json({ ...receipt, durable: true });
      }

      if (!taskId) return json({ error: 'taskId is required' }, 400);

      switch (url.pathname) {
        case '/start': {
          const input: SubmitInput = {
            id: taskId,
            profileId: (body.profileId as string | undefined) ?? 'default',
            goal: (body.goal as string | undefined) ?? taskId,
            conversationId: (body.conversationId as string | undefined) ?? null,
            question: body.question as string | undefined,
            waitTimeoutSec: body.waitTimeoutSec as number | undefined,
            crashRunOnce: body.crashRunOnce as boolean | undefined,
          };
          return json(await port.submit(input));
        }
        case '/signal':
          return json(
            await port.signal(taskId, (body.type as string | undefined) ?? 'user_reply', body.payload ?? {}, {
              idempotencyKey: body.idempotencyKey as string | undefined,
              source: body.source as 'telegram' | 'web' | 'api' | 'cron' | 'system' | undefined,
            }),
          );
        case '/cancel':
          return json(await port.cancel(taskId, { reason: body.reason as string | undefined }));
        case '/status':
          return json(await port.status(taskId));
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e), name: (e as Error)?.name }, errorStatus(e));
    }
  },
};
