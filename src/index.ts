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
import { IntakeService } from './intake';
import { logStructured } from './logging/structured-log';
import { EnvelopeConflictError, PrincipalForbiddenError, PrincipalUnauthorizedError } from './intake/errors';
import { AnswerConflictError, AnswerRejectedError } from './taskstore/errors';
import { runnerAdapterOf } from './runner-adapter';
import { RunnerNotFoundError, RunnerUnavailableError } from './runner-adapter/errors';
import { InvalidEnvelopeError } from './intake/envelope';
import { PilotRouter } from './pilot';
import { reportSnapshot, reportHistory, reportView } from './reporting';
import { ScheduleService, ScheduleStore, VirtualClock, portSubmitter, systemClock, type Clock } from './schedule';

export interface Env {
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
  /** Serverless Agent API (ai-agent-runner). Только из env, в репозитории нет. */
  RUNNER_API_URL?: string;
  RUNNER_API_KEY?: string;
  /**
   * Фиксированный «сейчас» расписания (epoch ms) — только для песочницы I07 на
   * виртуальных часах. В проде не задаётся: время берёт системный clock.
   */
  SCHEDULE_CLOCK?: string;
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
      // adapter строится из env (bindings), не из params: ключ Runner'а не
      // попадает в durable params экземпляра.
      return await conversationPlan(cfStepCtx(step), store, event.payload, {
        adapter: runnerAdapterOf(this.env),
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

const errorStatus = (e: unknown): number => {
  if (e instanceof InvalidEnvelopeError) return 400;
  if (e instanceof PrincipalUnauthorizedError) return 401;
  if (e instanceof PrincipalForbiddenError) return 403;
  if (e instanceof EnvelopeConflictError) return 409;
  if (e instanceof FencedError || e instanceof TerminalStateError) return 409;
  if (e instanceof TaskNotFoundError) return 404;
  if (e instanceof AnswerConflictError || e instanceof AnswerRejectedError) return 409;
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

/** Часы расписания: прод — системные, песочница/тесты — виртуальные. */
const scheduleClockOf = (env: Env): Clock =>
  env.SCHEDULE_CLOCK ? new VirtualClock(Number(env.SCHEDULE_CLOCK)) : systemClock;

const scheduleServiceOf = (env: Env, store: TaskStore, port: CfWorkflowPort, clock?: Clock): ScheduleService =>
  new ScheduleService({
    store: new ScheduleStore(env.DB),
    submitter: portSubmitter(port),
    clock: clock ?? scheduleClockOf(env),
  });

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
): Promise<Response> {
  const path = url.pathname.slice('/schedules'.length).replace(/\/$/, '') || '/';
  const service = scheduleServiceOf(env, store, port);
  const identity = { principalId: principalOf(req) ?? '' };

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
 const result = await intake.admit({ principalId: principalOf(req) ?? '' }, {
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
      // Host-owned interaction (шаг 5, гейт #115): durable ожидание и ответ по
      // ЯВНОМУ адресу awaitingInputId. Это и есть поверхность, которую дёргает
      // host-owned MCP tool исполнителя и канал пользователя.
      if (url.pathname === '/awaiting' || url.pathname.startsWith('/awaiting/')) {
        if (req.method === 'POST' && url.pathname === '/awaiting') {
          if (!taskId) return json({ error: 'taskId is required' }, 400);
          const task = await authorizeTaskRoute(store, req, taskId, 'tasks:control');
          const purpose = (body.purpose as AwaitingPurpose | undefined) ?? 'missing_fact';
          const opened = await store.openAwaiting({
            taskId,
            purpose,
            kind: body.kind as AwaitingKind | undefined,
            question: (body.question as string | undefined) ?? 'Нужен ваш ответ.',
            respondentScope: (body.respondentScope as string | undefined) ?? task.profile_id,
            step: (body.step as string | undefined) ?? null,
            runId: (body.runId as string | undefined) ?? null,
            schema: body.options ? { options: body.options } : undefined,
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
            },
            201,
          );
        }

        const parts = url.pathname.split('/').filter(Boolean); // ['awaiting', id?, 'answer'?]
        const awaitingInputId = parts[1] ?? null;
        if (!awaitingInputId) return json({ error: 'awaitingInputId is required' }, 400);

        if (req.method === 'GET' && parts.length === 2) {
          const row = await store.getAwaiting(awaitingInputId);
          if (!row) return json({ error: 'awaiting not found' }, 404);
          await authorizeTaskRoute(store, req, row.user_task_id, 'tasks:read');
          return json({ ...row, answer: row.answer_json ? JSON.parse(row.answer_json) : null });
        }

        if (req.method === 'POST' && parts[2] === 'answer') {
          const row = await store.getAwaiting(awaitingInputId);
          if (!row) return json({ error: 'awaiting not found' }, 404);
          const task = await authorizeTaskRoute(store, req, row.user_task_id, 'tasks:signal');
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
        return await handleScheduleRoute(req, url, env, store, port, body);
      }

      if (url.pathname === '/receipt') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        const receipt = await store.acceptReceipt(taskId);
        if (!receipt) return json({ error: 'receipt not found' }, 404);
        return json({ ...receipt, durable: true });
      }
      if (url.pathname === '/report') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read');
        const view = await reportView(store, taskId);
        return json(view);
      }
      if (url.pathname === '/report/history') {
        if (!taskId) return json({ error: 'taskId is required' }, 400);
        await authorizeTaskRoute(store, req, taskId, 'tasks:read');
        const after = url.searchParams.get('after');
        const limit = Number(url.searchParams.get('limit') ?? '100');
        const history = await reportHistory(store, taskId, after ? Number(after) : null, Number.isFinite(limit) ? limit : 100);
        return json(history);
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
            runnerEngine: body.runnerEngine as string | undefined,
          };
const startResult = await port.submit(input);
           return json({
             ...startResult,
             pilotRoute: startResult.pilotRoute,
             pilotReason: startResult.pilotReason,
           });
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
