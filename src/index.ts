import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { FencedError, TaskNotFoundError, TaskStore, TerminalStateError } from './taskstore';
import type { AdmissionScope, TaskRow } from './taskstore';
import { resolvePrincipal, requirePermission } from './intake/authorization';
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
  if (e instanceof TaskNotFoundError) return 404;
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
): Promise<TaskRow> => {
  const task = await store.getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  const principal = await resolvePrincipal(store, { principalId: principalOf(req) ?? '' });
  requirePermission(principal, task.profile_id, scope);
  return task;
};

const principalOf = (req: Request): string | null => req.headers.get('x-principal');

/**
 * Адаптер канала для локальной песочницы: доставка подтверждается без вызова
 * провайдера (сеть/Telegram вне зоны control plane). Настоящий канал подключает
 * карточка доставки M1.4 — контракт тот же (DeliveryAdapter).
 */
const localDeliveryAdapter: DeliveryAdapter = {
  send: async (delivery) => ({ providerMessageId: `local-${delivery.channel}-${delivery.id.slice(0, 8)}` }),
};

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
      if (url.pathname === '/events') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read');
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
        await authorizeTaskRoute(store, req, taskId, 'tasks:control');
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
      if (url.pathname === '/artifacts') {
        if (req.method !== 'POST') {
          if (!taskId) return json({ error: 'taskId is required' }, 400);
          await authorizeTaskRoute(store, req, taskId, 'tasks:read');
          return json({ artifacts: await store.listArtifacts(taskId) });
        }
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:control');
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
      if (url.pathname === '/receipt') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        const receipt = await store.acceptReceipt(taskId);
        if (!receipt) return json({ error: 'receipt not found' }, 404);
        return json({ ...receipt, durable: true });
      }

      if (!taskId) return json({ error: 'taskId is required' }, 400);

      switch (url.pathname) {
        case '/start': {
          await authorizeTaskRoute(store, req, taskId, 'tasks:intake');
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
          await authorizeTaskRoute(store, req, taskId, 'tasks:signal');
          return json(
            await port.signal(taskId, (body.type as string | undefined) ?? 'user_reply', body.payload ?? {}, {
              idempotencyKey: body.idempotencyKey as string | undefined,
              source: body.source as 'telegram' | 'web' | 'api' | 'cron' | 'system' | undefined,
            }),
          );
        case '/cancel':
          await authorizeTaskRoute(store, req, taskId, 'tasks:control');
          return json(await port.cancel(taskId, { reason: body.reason as string | undefined }));
        case '/status':
          await authorizeTaskRoute(store, req, taskId, 'tasks:read');
          return json(await port.status(taskId));
        case '/replay':
          await authorizeTaskRoute(store, req, taskId, 'tasks:control');
          return json(await port.replay(taskId, { fromStep: body.fromStep as string | undefined }));
        case '/resume':
          await authorizeTaskRoute(store, req, taskId, 'tasks:control');
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
};
