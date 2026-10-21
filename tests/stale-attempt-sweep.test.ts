// Sweep брошенных попыток (issue #367).
//
// До появления sweep'а попытка в статусе running без runner-сессии и попытка в
// статусе unknown (connection_lost) закрывались НЕКОГДА: задача жила месяцами.
// Проверяем границы: возрастной порог, generation-fence, терминальный guard и
// идемпотентность.
import worker from '../src/index';
import { TaskStore } from '../src/taskstore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';

const store = () => new TaskStore(env.DB);
const dbOf = (s: TaskStore): typeof env.DB => (s as unknown as { db: typeof env.DB }).db;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const RUNNING_MAX_AGE_MS = 10 * 60_000;
const UNKNOWN_MAX_AGE_MS = 2 * 60 * 60_000;

const created: string[] = [];

const admit = async (s: TaskStore, id = nextId('stale')) => {
  created.push(id);
  const { task } = await s.admitTask({ id, profileId: 'profile-stale', goal: 'зависшая задача' });
  return task;
};

/** Попытка, которая не вышла из CP: создана, но runner-сессия не привязана. */
const runningWithoutSession = async (s: TaskStore, taskId: string) =>
  s.startRun(taskId, { generation: (await s.requireTask(taskId)).generation, engine: 'cloudflare-workflows', sessionId: null });

/** Отодвинуть попытку в прошлое: возраст считается от started_at. */
const backdate = async (s: TaskStore, attemptId: string, ageMs: number) => {
  await dbOf(s)
    .prepare('UPDATE executions SET started_at = ? WHERE id = ?')
    .bind(Date.now() - ageMs, attemptId)
    .run();
};

// Общий D1 на все файлы: убираем за собой, чтобы брошенные попытки не достались
// следующему прогону (иначе sweep споткнулся бы о чужую запись).
afterEach(async () => {
  const s = store();
  while (created.length) {
    const id = created.pop()!;
    await dbOf(s).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
  }
});

describe('Sweep брошенных попыток: running без runner-сессии (issue #367)', () => {
  it('попытка старше порога закрывается как failed, задача уходит в failed', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS + 60_000);

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(1);
    const after = await s.requireTask(task.id);
    expect(after.status).toBe('failed');
    expect(after.stage).toBe('finished');
    const runs = await s.listRuns(task.id);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error_class).toBe('stale_attempt');
    expect(runs[0]!.finished_at).toBeGreaterThan(0);
  });

  it('в журнале видно run_finished и task_status_changed', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS + 60_000);

    await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    const events = await s.history(task.id);
    const finished = events.find((e) => e.kind === 'run_finished');
    expect(finished).toBeDefined();
    expect(JSON.parse(finished!.payload_json).errorClass).toBe('stale_attempt');
    const statusChanged = events.find((e) => e.kind === 'task_status_changed');
    expect(statusChanged).toBeDefined();
    expect(statusChanged!.status_before).toBe('active');
    expect(statusChanged!.status_after).toBe('failed');
    expect(statusChanged!.generation).toBe(task.generation);
  });

  it('молодая попытка не трогается', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS - 60_000);

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);
    expect((await s.requireTask(task.id)).status).toBe('active');
    expect((await s.listRuns(task.id))[0]!.status).toBe('running');
  });
});

describe('Sweep брошенных попыток: unknown (connection_lost)', () => {
  it('попытка unknown старше порога закрывается как failed', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await s.markConnectionLost(attempt.id, 'runner connection_lost');
    await backdate(s, attempt.id, UNKNOWN_MAX_AGE_MS + 60_000);

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(1);
    expect((await s.requireTask(task.id)).status).toBe('failed');
    const run = (await s.listRuns(task.id))[0]!;
    expect(run.status).toBe('failed');
    expect(run.error_class).toBe('stale_unknown');
  });

  it('unknown моложе порога не трогается (окно сверки ещё не вышло)', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await s.markConnectionLost(attempt.id, 'runner connection_lost');
    await backdate(s, attempt.id, UNKNOWN_MAX_AGE_MS - 60_000);

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);
    expect((await s.requireTask(task.id)).status).toBe('active');
    expect((await s.listRuns(task.id))[0]!.status).toBe('unknown');
  });
});

describe('Sweep брошенных попыток: границы (issue #367)', () => {
  it('попытка прежнего поколения не трогается: у задачи уже идёт новая попытка', async () => {
    const s = store();
    const task = await admit(s);
    const stale = await runningWithoutSession(s, task.id);
    await backdate(s, stale.id, RUNNING_MAX_AGE_MS + 60_000);
    // Поколение поднято — прежняя попытка лишена прав на запись.
    await s.bumpGeneration(task.id, { reason: 'test_resume' });

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);
    expect((await s.requireTask(task.id)).status).toBe('active');
    expect((await s.listRuns(task.id))[0]!.status).toBe('running');
  });

  it('терминальная задача не трогается', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS + 60_000);
    await s.commit(task.id, task.generation, { status: 'done', stage: 'finished', result: { ok: true } });

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);
    const after = await s.requireTask(task.id);
    expect(after.status).toBe('done');
    expect((await s.statusRow(task.id))?.result).toEqual({ ok: true });
  });

  it('sweep идемпотентен: повторный проход ничего не меняет', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS + 60_000);

    const first = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);
    const historyAfterFirst = (await s.history(task.id)).length;
    const second = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(first.closed).toBe(1);
    expect(second.scanned).toBe(0);
    expect(second.closed).toBe(0);
    expect((await s.history(task.id)).length).toBe(historyAfterFirst);
    expect((await s.requireTask(task.id)).status).toBe('failed');
  });

  it('попытка с привязанной runner-сессией не закрывается: исход может ещё подтвердиться', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await s.startRun(task.id, {
      generation: task.generation,
      engine: 'cloudflare-workflows',
      sessionId: `runner-${task.id}`,
    });
    await backdate(s, attempt.id, UNKNOWN_MAX_AGE_MS + 60_000);

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);
    expect((await s.requireTask(task.id)).status).toBe('active');
  });

  it('задача, которой ответ уже ушёл в канал, не трогается вовсе', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS + 60_000);
    // Ответ доставлен пользователю — «исполнитель ошибся» противоречило бы тому,
    // что человек уже видел. Такой разбор — другой класс, не sweep попыток.
    await dbOf(s)
      .prepare("UPDATE durable_tasks SET delivery_state = 'delivered' WHERE id = ?")
      .bind(task.id)
      .run();

    const result = await s.sweepStaleAttempts(Date.now(), RUNNING_MAX_AGE_MS, UNKNOWN_MAX_AGE_MS);

    expect(result.scanned).toBe(0);
    expect(result.closed).toBe(0);
    expect((await s.requireTask(task.id)).status).toBe('active');
    expect((await s.listRuns(task.id))[0]!.status).toBe('running');
  });
});

describe('Sweep брошенных попыток: планировщик (issue #367)', () => {
  it('scheduled-проход вызывает sweep брошенных попыток', async () => {
    const sweep = vi.spyOn(TaskStore.prototype, 'sweepStaleAttempts');
    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
        { ...env, DELIVERY_ADAPTER: 'local' } as never,
        { waitUntil: () => {}, passedWhileWaiting: false } as unknown as ExecutionContext,
      );
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally {
      sweep.mockRestore();
    }
  });

  it('scheduled-проход закрывает брошенную попытку, а задача становится failed', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, RUNNING_MAX_AGE_MS + 60_000);

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
      { ...env, DELIVERY_ADAPTER: 'local' } as never,
      { waitUntil: () => {}, passedWhileWaiting: false } as unknown as ExecutionContext,
    );

    expect((await s.requireTask(task.id)).status).toBe('failed');
    expect((await s.listRuns(task.id))[0]!.error_class).toBe('stale_attempt');
  });

  it('порог настраивается окружением', async () => {
    const s = store();
    const task = await admit(s);
    const attempt = await runningWithoutSession(s, task.id);
    await backdate(s, attempt.id, 30_000);

    // Дефолтный порог (10 мин) молодая попытку не трогает...
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
      { ...env, DELIVERY_ADAPTER: 'local' } as never,
      { waitUntil: () => {}, passedWhileWaiting: false } as unknown as ExecutionContext,
    );
    expect((await s.requireTask(task.id)).status).toBe('active');

    // ...а переопределённый порог закрывает её.
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
      { ...env, DELIVERY_ADAPTER: 'local', STALE_RUNNING_NO_SESSION_MAX_AGE_MS: '1000' } as never,
      { waitUntil: () => {}, passedWhileWaiting: false } as unknown as ExecutionContext,
    );
    expect((await s.requireTask(task.id)).status).toBe('failed');
  });
});
