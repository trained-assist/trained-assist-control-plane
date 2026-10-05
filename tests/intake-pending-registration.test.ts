import { TaskStore } from '../src/taskstore';
import { runStuckInputSweep, runStuckInputWatchdog } from '../src/intake';
import { IntakeService } from '../src/intake';
import { describe, expect, it, beforeEach } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const dbOf = (store: TaskStore): typeof env.DB => (store as unknown as { db: typeof env.DB }).db;

const batches: string[] = [];
const tasks: string[] = [];
const trackBatch = (id: string) => { batches.push(id); return id; };
const trackTask = (id: string) => { tasks.push(id); return id; };

beforeEach(async () => {
  const store = new TaskStore(env.DB);
  for (const id of batches.splice(0)) {
    await dbOf(store).prepare('DELETE FROM pending_inputs WHERE batch_id = ?').bind(id).run();
  }
  for (const id of tasks.splice(0)) {
    await dbOf(store).prepare('DELETE FROM deliveries WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM task_events WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
  }
});

const setup = () => new TaskStore(env.DB);

describe('пакет накопителя виден детектору ДО admitTask (arch#132 R9)', () => {
  it('приём пакета кладёт его в окно «до запуска» с временем ПЕРВОГО сообщения', async () => {
    const store = setup();
    const first = Date.now() - 90_000; // первый вход полторы минуты назад
    const batchId = trackBatch(nextId('batch'));

    await store.recordPendingInput({
      batchId, version: 1, profileId: 'profile-1', channel: 'telegram',
      destinationId: '-5111318625', firstMessageAt: first, deadlineMs: 60_000,
    });

    const row = await store.requirePendingInput(batchId);
    expect(row.prep_state).toBe('collecting');
    expect(row.first_message_at).toBe(first);
    expect(row.user_task_id).toBeNull();
  });

  it('НОВЫЕ сообщения не подменяют возраст самого старого ввода', async () => {
    const store = setup();
    const first = Date.now() - 90_000;
    const batchId = trackBatch(nextId('batch'));
    await store.recordPendingInput({
      batchId, version: 1, profileId: 'profile-1', channel: 'telegram',
      destinationId: '-5111318625', firstMessageAt: first, deadlineMs: 60_000,
    });
    // Активный чат продолжает слать; каждое сообщение — с текущим временем.
    for (let i = 0; i < 3; i++) {
      await store.recordPendingInput({
        batchId, version: 1, profileId: 'profile-1', channel: 'telegram',
        destinationId: '-5111318625', firstMessageAt: Date.now(), deadlineMs: 60_000,
      });
    }
    const row = await store.requirePendingInput(batchId);
    expect(row.first_message_at).toBe(first); // возраст самого старого — виден
    expect(row.message_count).toBe(4);
  });

  it('просроченный пакет находит детектор, свежий — нет', async () => {
    const store = setup();
    const stale = trackBatch(nextId('stale'));
    const fresh = trackBatch(nextId('fresh'));
    await store.recordPendingInput({ batchId: stale, version: 1, profileId: 'p', channel: 'telegram', destinationId: '-1', firstMessageAt: Date.now(), deadlineMs: 1 });
    await store.recordPendingInput({ batchId: fresh, version: 1, profileId: 'p', channel: 'telegram', destinationId: '-1', firstMessageAt: Date.now(), deadlineMs: 600_000 });
    await new Promise((r) => setTimeout(r, 5));

    const result = await runStuckInputWatchdog(store, {}, Date.now());
    expect(result.tasks).toContain(stale);
    expect(result.tasks).not.toContain(fresh);
  });

  it('приём задачи связывает пакет и выводит его из окна «до запуска»', async () => {
    const store = setup();
    const batchId = trackBatch(nextId('batch'));
    await store.recordPendingInput({ batchId, version: 1, profileId: 'p1', channel: 'telegram', destinationId: '-5111318625', firstMessageAt: Date.now() - 5000, deadlineMs: 60_000 });

    await store.upsertPrincipal({ principalId: 'principal-1', profileId: 'p1', scopes: ['tasks:intake'] });
    const service = new IntakeService(store);
    const res = await service.admit(
      { principalId: 'principal-1' },
      {
        requestId: nextId('req'),
        inputItems: [{ kind: 'text', text: 'сделай отчёт' }],
        pendingBatchId: batchId,
      } as never,
    );
    expect(res.duplicate).toBe(false);
    trackTask(res.userTaskId);

    const row = await store.requirePendingInput(batchId);
    expect(row.user_task_id).toBe(res.userTaskId);
    expect(row.prep_state).toBe('admitted');
    // И больше не в выборке детектора.
    expect((await store.sweepStuckPendingInputs(Date.now())).map((r) => r.batch_id)).not.toContain(batchId);
  });

  it('снятый пакет (отмена/чистка) больше не считается зависшим', async () => {
    const store = setup();
    const batchId = trackBatch(nextId('batch'));
    await store.recordPendingInput({ batchId, version: 1, profileId: 'p', channel: 'telegram', destinationId: '-1', firstMessageAt: Date.now() - 5000, deadlineMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect((await store.sweepStuckPendingInputs(Date.now())).map((r) => r.batch_id)).toContain(batchId);

    await store.dropPendingInput(batchId, 'cleared');
    expect((await store.sweepStuckPendingInputs(Date.now())).map((r) => r.batch_id)).not.toContain(batchId);
  });

  it('уведомление по пакету до приёма не выдумывает доставку — задачи ещё нет', async () => {
    const store = setup();
    const batchId = trackBatch(nextId('batch'));
    await store.recordPendingInput({ batchId, version: 1, profileId: 'p', channel: 'telegram', destinationId: '-1', firstMessageAt: Date.now() - 500_000, deadlineMs: 1 });
    await new Promise((r) => setTimeout(r, 5)); // дедлайн в 1 мс должен истечь

    const result = await runStuckInputSweep(store, {}, Date.now());
    // Пакет найден и описан, но поставить доставку некуда: userTaskId нет, а
    // придумывать адресата для задачи, которой не существует, нельзя.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.queued).toBe(0);
    expect(result.skippedStale).toBe(0);
  });
});
