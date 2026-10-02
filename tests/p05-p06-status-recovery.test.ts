import { introspectWorkflowInstance } from 'cloudflare:test';
import { toC02Event } from '../src/events';
import { FencedError, TaskStore } from '../src/taskstore';
import { CfWorkflowPort, PLAN_VERSION } from '../src/workflow-port';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pollUntil = async <T>(label: string, fn: () => Promise<T | null | undefined>, timeoutMs = 30_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
};

const setup = () => {
  const store = new TaskStore(env.DB);
  const port = new CfWorkflowPort(env.TASK_WORKFLOW, store);
  return { store, port };
};

const submitAndPark = async (store: TaskStore, port: CfWorkflowPort, taskId = nextId('p05')) => {
  const submit = await port.submit({ id: taskId, profileId: 'p', goal: 'P05/P06' });
  await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));
  return submit;
};

describe('P05: поток событий с курсором (C02)', () => {
  it('курсор воспроизводит историю без потерь и дублей (разрыв потока не теряет итог)', async () => {
    const { store, port } = setup();
    const taskId = nextId('events');
    await submitAndPark(store, port, taskId);

    // Клиент с разрывом: читает страницами, каждый раз с последним виденным sequence.
    const seen: number[] = [];
    let cursor: number | null = null;
    for (;;) {
      const page = await store.eventsAfter(taskId, cursor, 2);
      for (const e of page.events) {
        expect(seen).not.toContain(e.id);
        seen.push(e.id);
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }

    const all = await store.history(taskId);
    expect(seen).toEqual(all.map((e) => e.id));
    expect(seen.length).toBeGreaterThan(3);
  });

  it('envelope C02: type выводится из kind, sequence = task_events.id', async () => {
    const { store, port } = setup();
    const taskId = nextId('c02');
    await submitAndPark(store, port, taskId);
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:c02' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });

    const page = await store.eventsAfter(taskId, null, 100);
    const envelopes = page.events.map(toC02Event);
    const byKind = new Map(envelopes.map((e) => [e.kind, e.type]));

    expect(byKind.get('task_accepted')).toBe('accepted');
    expect(byKind.get('run_started')).toBe('started');
    expect(byKind.get('awaiting_opened')).toBe('waiting');
    expect(byKind.get('signal_received')).toBe('progress');
    expect(byKind.get('awaiting_answered')).toBe('progress');
    // task_status_changed несёт разные переходы — тип выводится из status_after
    const doneRow = page.events.find((e) => e.kind === 'task_status_changed' && e.status_after === 'done');
    expect(doneRow).toBeDefined();
    expect(toC02Event(doneRow!).type).toBe('result_ready');

    for (const e of envelopes) {
      expect(e.sequence).toBeGreaterThan(0);
      expect(e.userTaskId).toBe(taskId);
      expect(e.occurredAt).toBeGreaterThan(0);
      expect(e.kind).toBeTruthy();
    }
  });

  it('status — только чтение: не запускает агента и не меняет состояние', async () => {
    const { store, port } = setup();
    const taskId = nextId('readonly');
    await submitAndPark(store, port, taskId);

    const before = await store.statusRow(taskId);
    const eventsBefore = await store.history(taskId);
    for (let i = 0; i < 5; i++) await port.status(taskId);

    const after = await store.statusRow(taskId);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.generation).toBe(before?.generation);
    expect(await store.history(taskId)).toEqual(eventsBefore);
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('queued/starting/running/terminal различимы по status+stage+attempt', async () => {
    const { store, port } = setup();
    const taskId = nextId('phases');
    const submit = await port.submit({ id: taskId, profileId: 'p', goal: 'фазы' });

    // принята, ещё не запущена: active/queued
    let task = await store.requireTask(taskId);
    expect(task.status).toBe('active');
    expect(task.stage).toBe('queued');
    expect(submit.runId).not.toBeNull();

    // запущена: попытка running
    const run = await store.getRun(submit.runId!);
    expect(run?.status).toBe('running');

    // ждём ответа: awaiting_input/waiting_input
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));
    task = await store.requireTask(taskId);
    expect(task.status).toBe('awaiting_input');
    expect(task.stage).toBe('waiting_input');

    // терминал: done/finished
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:phases' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    task = await store.requireTask(taskId);
    expect(task.status).toBe('done');
    expect(task.stage).toBe('finished');
    const finishedRun = await store.getRun(submit.runId!);
    expect(finishedRun?.status).toBe('success');
    expect(finishedRun?.finished_at).not.toBeNull();
  });
});

describe('P05/P06: replay без rerun и отмена', () => {
  it('replay потока без rerun: переподключение с курсором воспроизводит итог', async () => {
    const { store, port } = setup();
    const taskId = nextId('replay-stream');
    await submitAndPark(store, port, taskId);

    // Клиент прочитал поток до курсора и "отключился".
    const page1 = await store.eventsAfter(taskId, null, 100);
    const cursor = page1.nextCursor;
    expect(cursor).not.toBeNull();

    // Пока клиент офлайн, задача доходит до done — без открытой вкладки.
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:offline' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });

    // Переподключение: читаем с последнего виденного sequence.
    const page2 = await store.eventsAfter(taskId, cursor, 100);
    const all = await store.history(taskId);
    const ids = new Set(all.map((e) => e.id));
    expect(page2.events.length).toBe(all.length - page1.events.length);
    for (const e of page2.events) expect(ids.has(e.id)).toBe(true);

    // Итог воспроизводится: результат и финальные события на месте.
    expect((await store.statusRow(taskId))?.result).toEqual({
      answer: 'да',
      ok: true,
      version: PLAN_VERSION,
    });
    // Никакого rerun: одна попытка, одно событие старта.
    expect(all.filter((e) => e.kind === 'run_started')).toHaveLength(1);
    expect(await store.listRuns(taskId)).toHaveLength(1);
  }, 60_000);

  it('restart экземпляра: план идемпотентен, состояние не дублируется', async () => {
    const { store, port } = setup();
    const taskId = nextId('restart');
    const submit = await submitAndPark(store, port, taskId);

    await port.replay(taskId);

    // Задача валидна и снова ждёт: ожидание не потеряно, состояние не продублировано.
    await pollUntil('awaiting_input после restart', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'awaiting_input' ? row : null;
    });
    expect(await store.getOpenAwaiting(taskId)).not.toBeNull();

    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:after-restart' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    expect((await store.statusRow(taskId))?.result).toEqual({
      answer: 'да',
      ok: true,
      version: PLAN_VERSION,
    });
    // Попытка завершена один раз, результат один.
    const run = await store.getRun(submit.runId!);
    expect(run?.status).toBe('success');
    expect(run?.finished_at).not.toBeNull();
  }, 60_000);

  it('restart после done: план выходит без шагов, состояние не меняется', async () => {
    const { store, port } = setup();
    const taskId = nextId('restart-done');
    await submitAndPark(store, port, taskId);
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:rd-1' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    const before = await store.statusRow(taskId);

    await port.replay(taskId);

    // План выходит без шагов: новых событий нет, состояние не изменилось.
    await pollUntil('restart после done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    const after = await store.statusRow(taskId);
    expect(after?.status).toBe('done');
    expect(after?.result).toEqual(before?.result);
    expect(after?.revision).toBe(before?.revision);
  }, 60_000);

  it('cancel requested != stopped: сбой terminate не переводит задачу в cancelled', async () => {
    const { store, port } = setup();
    const taskId = nextId('cancel-unconfirmed');
    await submitAndPark(store, port, taskId);

    // Управляемый сбой: terminate падает.
    const failingWf = {
      get: async (id: string) => ({
        status: async () => ({ status: 'running' }),
        sendEvent: async () => {},
        terminate: async () => {
          throw new Error('injected: terminate failed');
        },
      }),
    };
    const failingPort = new CfWorkflowPort(failingWf as unknown as Workflow, store);

    const res = await failingPort.cancel(taskId, { reason: 'user pressed stop' });
    expect(res.cancelled).toBe(false);
    expect(res.stopConfirmed).toBe(false);

    // Задача не терминальна, запрос на отмену виден, поколение поднято.
    const task = await store.requireTask(taskId);
    expect(['active', 'awaiting_input']).toContain(task.status);
    const events = await store.history(taskId);
    expect(events.some((e) => e.kind === 'cancel_requested')).toBe(true);
    expect(events.some((e) => e.kind === 'task_cancelled')).toBe(false);

    // Повторный cancel без сбоя подтверждает остановку.
    const confirmed = await port.cancel(taskId, { reason: 'user pressed stop' });
    expect(confirmed.cancelled).toBe(true);
    expect(confirmed.stopConfirmed).toBe(true);
    expect((await store.requireTask(taskId)).status).toBe('cancelled');
    expect((await store.history(taskId)).some((e) => e.kind === 'task_cancelled')).toBe(true);
  }, 60_000);

  it('resume после упавшего экземпляра: terminate не блокирует delete+create', async () => {
    const { store, port } = setup();
    const taskId = nextId('resume-errored');
    const submit = await port.submit({ id: taskId, profileId: 'p', goal: 'упавший экземпляр' });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    // Доводим экземпляр до errored: поднимаем поколение и будим сигналом —
    // план пишет старым поколением, получает fencing и падает (NonRetryable).
    await store.bumpGeneration(taskId, { reason: 'test: force errored' });
    const instance = await introspectWorkflowInstance(env.TASK_WORKFLOW, taskId);
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:errored' });
    await instance.waitForStatus('errored');
    await instance.dispose();

    // resume: terminate по errored бросает, но delete+create обязаны поднять новый.
    const resumed = await port.resume(taskId, { reason: 'recover after errored' });
    expect(resumed.runId).toBeTruthy();
    expect(resumed.runId).not.toBe(submit.runId);
    expect(resumed.generation).toBeGreaterThan(submit.generation);

    // Ответ уже сохранён durable (сигнал применился по актуальному поколению),
    // поэтому продолжение идёт от него сразу к результату, не открывая новый вопрос.
    await pollUntil('done после resume', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    expect((await store.statusRow(taskId))?.result).toEqual({
      answer: 'да',
      ok: true,
      version: PLAN_VERSION,
    });
  }, 60_000);

  it('отмена адресна: затронута только своя задача', async () => {
    const { store, port } = setup();
    const a = nextId('cancel-a');
    const b = nextId('cancel-b');
    await submitAndPark(store, port, a);
    await submitAndPark(store, port, b);

    await port.cancel(a);
    expect((await store.requireTask(a)).status).toBe('cancelled');
    expect((await store.requireTask(b)).status).toBe('awaiting_input');
  }, 60_000);
});

describe('P06: потеря связи, lease и возобновление', () => {
  it('connection_lost = отдельное состояние: попытка unknown, задача не failed', async () => {
    const { store, port } = setup();
    const taskId = nextId('conn-lost');
    const submit = await submitAndPark(store, port, taskId);

    const run = await port.markConnectionLost(submit.runId!, 'heartbeat lost');
    expect(run.status).toBe('unknown');
    expect(run.error_class).toBe('connection_lost');
    expect(run.finished_at).toBeNull();

    // Задача не изменилась: ни failed, ни cancelled.
    const task = await store.requireTask(taskId);
    expect(task.status).toBe('awaiting_input');
    expect(task.generation).toBe(submit.generation);

    // Попытка завершить уже завершённую нельзя, heartbeat отклоняется.
    await expect(port.heartbeat(submit.runId!)).rejects.toThrow(/heartbeat rejected/);
    await expect(port.markConnectionLost(submit.runId!)).rejects.toThrow(/connection_lost rejected/);
  });

  it('истечение lease не запускает агента повторно (только сводка)', async () => {
    const { store, port } = setup();
    const taskId = nextId('lease');
    const submit = await submitAndPark(store, port, taskId);

    // Управляемый сбой: lease уже истёк.
    await env.DB.prepare(`UPDATE executions SET lease_until = ? WHERE id = ?`)
      .bind(Date.now() - 1000, submit.runId!)
      .run();

    const expired = await store.sweepExpiredLeases();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe(submit.runId);

    // Никаких действий: тот же run, ни новых событий, задача не изменилась.
    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect((await store.history(taskId)).filter((e) => e.kind === 'run_started')).toHaveLength(1);
    expect((await store.requireTask(taskId)).status).toBe('awaiting_input');

    // Heartbeat продлевает lease и снимает кандидата с сводки.
    await port.heartbeat(submit.runId!);
    expect(await store.sweepExpiredLeases()).toHaveLength(0);
  });

  it('resume: новый runId, тот же userTaskId, старая попытка лишена прав', async () => {
    const { store, port } = setup();
    const taskId = nextId('resume');
    const submit = await submitAndPark(store, port, taskId);
    const oldRunId = submit.runId!;

    await port.markConnectionLost(oldRunId, 'heartbeat lost');
    const res = await port.resume(taskId, { reason: 'reconnect', instructions: 'продолжить после обрыва' });

    expect(res.runId).not.toBe(oldRunId);
    expect(res.generation).toBe(submit.generation + 1);

    // Прежняя попытка отвергается fencing'ом.
    await expect(store.commit(taskId, submit.generation, { status: 'done' })).rejects.toBeInstanceOf(FencedError);

    // Новая попытка активна, задача всё ещё ждёт.
    const newRun = await store.getRun(res.runId);
    expect(newRun?.status).toBe('running');
    expect(newRun?.generation).toBe(res.generation);
    expect((await store.requireTask(taskId)).status).toBe('awaiting_input');

    // Сигнал после resume доводит до done; повтор того же ключа дедуплицируется.
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:resume-1' });
    const dup = await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:resume-1' });
    expect(dup.duplicate).toBe(true);

    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    const runs = await store.listRuns(taskId);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === oldRunId)?.status).toBe('unknown');
    expect(runs.find((r) => r.id === res.runId)?.status).toBe('success');
  }, 60_000);
});