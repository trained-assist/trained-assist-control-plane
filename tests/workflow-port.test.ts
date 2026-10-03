import { abortAllDurableObjects, introspectWorkflowInstance } from 'cloudflare:test';
import { FencedError, TaskStore } from '../src/taskstore';
import { CfWorkflowPort, PLAN_VERSION } from '../src/workflow-port';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pollUntil = async <T>(
  label: string,
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 30_000,
): Promise<T> => {
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

const historyKinds = async (store: TaskStore, taskId: string): Promise<string[]> =>
  (await store.history(taskId)).map((e) => e.kind);

describe('Workflow Port: submit -> wait -> сигнал -> done', () => {
  it('сквозной прогон: ранний ответ, парковка, сигнал, терминальный результат', async () => {
    const { store, port } = setup();
    const taskId = nextId('happy');

    const t0 = Date.now();
    const submit = await port.submit({
      id: taskId,
      profileId: 'profile-1',
      goal: 'сквозной прогон M1.2',
      conversationId: `conv-${taskId}`,
      // Typed-запрос хоста: без него план не открывает ожидание (one-shot).
      awaitingPurpose: 'missing_fact',
    });
    const submitMs = Date.now() - t0;

    expect(submit.created).toBe(true);
    expect(submit.instanceCreated).toBe(true);
    // Ранний ответ: submit возвращается до того, как план дошёл до конца
    // (план обязан ждать сигнал — задача не может быть терминальна сразу).
    expect(submitMs).toBeLessThan(5_000);
    const statusNow = await store.requireTask(taskId);
    expect(['done', 'failed', 'cancelled']).not.toContain(statusNow.status);

    // План паркуется на ожидании ответа.
    await pollUntil('awaiting_input', async () => {
      const open = await store.getOpenAwaiting(taskId);
      return open ? open : null;
    });
    const awaiting = await store.requireTask(taskId);
    expect(awaiting.status).toBe('awaiting_input');
    expect(awaiting.stage).toBe('waiting_input');
    expect(awaiting.awaiting_input_id).not.toBeNull();

    // Сигнал пользователя будит экземпляр.
    const signal = await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:msg-1' });
    expect(signal.delivered).toBe(true);
    expect(signal.duplicate).toBe(false);

    const done = await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    expect(done.stage).toBe('finished');

    const status = await store.statusRow(taskId);
    expect(status?.result).toEqual({
      ok: true,
      // Ответ человека не подменяет текст движка: движка в этом прогоне нет.
      answer: null,
      userAnswer: 'да',
      version: PLAN_VERSION,
      mode: 'no_engine',
    });

    // Ожидание закрыто, сигнал потреблён, история полная и упорядочена.
    expect(await store.getOpenAwaiting(taskId)).toBeNull();
    const signals = await store.listSignals(taskId);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.consumed_at).not.toBeNull();

    const kinds = await historyKinds(store, taskId);
    const idx = (k: string) => {
      const i = kinds.indexOf(k);
      expect(i, `нет события ${k} в [${kinds.join(', ')}]`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(idx('task_accepted')).toBeLessThan(idx('run_started'));
    expect(idx('run_started')).toBeLessThan(idx('awaiting_opened'));
    expect(idx('awaiting_opened')).toBeLessThan(idx('signal_received'));
    expect(idx('signal_received')).toBeLessThan(idx('step_woken'));
    expect(idx('step_woken')).toBeLessThan(idx('awaiting_answered'));
    expect(idx('awaiting_answered')).toBeLessThan(idx('task_status_changed'));
  }, 60_000);

  it('дубль submit = один запуск: тот же экземпляр, один task_accepted, один prepare', async () => {
    const { store, port } = setup();
    const taskId = nextId('dup-submit');
    const input = { id: taskId, profileId: 'p', goal: 'дубль submit', awaitingPurpose: 'missing_fact' as const };

    const first = await port.submit(input);
    const second = await port.submit(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.instanceCreated).toBe(false);
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.generation).toBe(first.generation);

    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));
    await sleep(300);

    const events = await store.history(taskId);
    expect(events.filter((e) => e.kind === 'task_accepted')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'run_started')).toHaveLength(1);
    expect(events.filter((e) => e.task_item_id === 'prepare')).toHaveLength(1);

    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:dup-1' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    expect((await store.history(taskId)).filter((e) => e.task_item_id === 'prepare')).toHaveLength(1);
  }, 60_000);

  it('позднее событие после done отклоняется портом: статус и result не тронуты', async () => {
    const { store, port } = setup();
    const taskId = nextId('late-event');

    await port.submit({ id: taskId, profileId: 'p', goal: 'позднее событие', awaitingPurpose: 'missing_fact' });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));
    await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:ok-1' });
    await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });

    const before = await store.statusRow(taskId);

    // Поздний ответ пользователя после терминального статуса.
    const late = await port.signal(taskId, 'user_reply', { answer: 'поздно' }, { idempotencyKey: 'web:late-1' });
    expect(late.delivered).toBe(false);
    expect(late.reason).toBe('terminal_state');

    const after = await store.statusRow(taskId);
    expect(after?.status).toBe('done');
    expect(after?.result).toEqual(before?.result);
    expect(after?.revision).toBe(before?.revision);

    // Сигнал сохранён строкой с rejected_reason, а не выброшен.
    const signals = await store.listSignals(taskId);
    expect(signals).toHaveLength(2);
    const rejected = signals.find((s) => s.rejected_reason === 'terminal_state');
    expect(rejected).toBeDefined();
    expect(JSON.parse(rejected!.payload_json)).toEqual({ answer: 'поздно' });

    // И дубль того же ключа — no-op в таблице сигналов.
    const dup = await port.signal(taskId, 'user_reply', { answer: 'поздно' }, { idempotencyKey: 'web:late-1' });
    expect(dup.duplicate).toBe(true);
    expect(await store.listSignals(taskId)).toHaveLength(2);
  }, 60_000);

  it('запись со старым generation отклоняется: экземпляр падает, статус не меняется', async () => {
    const { store, port } = setup();
    const taskId = nextId('stale-gen');

    const instance = await introspectWorkflowInstance(env.TASK_WORKFLOW, taskId);
    const submit = await port.submit({ id: taskId, profileId: 'p', goal: 'старый generation', awaitingPurpose: 'missing_fact' });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    // Новый владелец взял задачу (lease истёк) — поколение поднято.
    const newGeneration = await store.bumpGeneration(taskId, { reason: 'lease expired' });
    expect(newGeneration).toBe(submit.generation + 1);

    const signal = await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:stale-1' });
    expect(signal.delivered).toBe(true);

    // План просыпается и пишет от СТАРОГО поколения -> fencing -> NonRetryable.
    await instance.waitForStatus('errored');
    await instance.dispose();

    // Ответ человека при этом сохранён: host применяет его по АКТУАЛЬНОМУ
    // поколению (ответ не блокируется «протухшим» исполнителем), поэтому
    // ожидание закрыто и задача вернулась в active. Продолжение — новой попыткой.
    const row = await store.requireTask(taskId);
    expect(row.status).toBe('active');
    expect(row.generation).toBe(newGeneration);
    expect(await store.getOpenAwaiting(taskId)).toBeNull();

    const events = await store.history(taskId);
    const fenced = events.find((e) => e.kind === 'fenced');
    expect(fenced).toBeDefined();
    expect(fenced!.generation).toBe(submit.generation);

    // Свежий владелец дводит задачу до конца: ответ уже durable, повторно его
    // применять не нужно.
    await store.commit(taskId, newGeneration, {
      status: 'done',
      stage: 'finished',
      step: 'finalize',
      result: { ok: true, answer: null, userAnswer: 'да', version: PLAN_VERSION, mode: 'no_engine' },
    });
    expect((await store.requireTask(taskId)).status).toBe('done');
  }, 60_000);

  it('рестарт исполнителя посередине: запись переживает обрыв, платформа продолжает сама', async () => {
    const { store, port } = setup();
    const taskId = nextId('restart');

    const submit = await port.submit({
      id: taskId,
      profileId: 'p',
      goal: 'рестарт посередине',
      crashRunOnce: true,
      awaitingPurpose: 'missing_fact',
    });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    const before = await store.statusRow(taskId);
    expect(before?.status).toBe('awaiting_input');

    // Смерть исполнителя: in-memory состояние Durable Object уходит, D1 остаётся.
    await abortAllDurableObjects();

    const afterRestart = new TaskStore(env.DB);
    const row = await afterRestart.statusRow(taskId);
    expect(row?.status).toBe('awaiting_input');
    expect(row?.awaiting_input_id).toBe(before?.awaiting_input_id);
    expect(row?.history).toEqual(before?.history);

    // Сигнал после рестарта будит экземпляр заново.
    const signal = await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:after-restart' });
    expect(signal.delivered).toBe(true);

    const done = await pollUntil('done после рестарта', async () => {
      const r = await afterRestart.requireTask(taskId);
      return r.status === 'done' ? r : null;
    });
    expect(done.status).toBe('done');
    expect((await afterRestart.statusRow(taskId))?.result).toEqual({
      ok: true,
      answer: null,
      userAnswer: 'да',
      version: PLAN_VERSION,
      mode: 'no_engine',
    });
  }, 60_000);

  it('поздний wait_timeout не перезаписывает done на уровне плана (суть #90)', async () => {
    const { store, port } = setup();
    const taskId = nextId('late-timeout');

    const instance = await introspectWorkflowInstance(env.TASK_WORKFLOW, taskId);
    const submit = await port.submit({
      id: taskId,
      profileId: 'p',
      goal: 'поздний тайм-аут ожидания',
      awaitingPurpose: 'missing_fact',
      // Короткий дедлайн: тайм-аут ожидания должен наступить ПОСЛЕ того, как
      // задача закрыта извне, — ровно окно, в котором пилот писал wait_timeout
      // поверх done (issue #90).
      waitTimeoutSec: 5,
    });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    // Другой актор закрыл задачу, пока экземпляр ждал ответа.
    await store.commit(taskId, submit.generation, {
      status: 'done',
      stage: 'finished',
      step: 'finalize',
      result: { ok: true, answer: null, userAnswer: 'да', version: PLAN_VERSION, mode: 'no_engine' },
    });
    const before = await store.statusRow(taskId);

    // waitForEvent истекает сам (в пилоте это и порождало wait_timeout поверх done).
    await instance.waitForStatus('complete');
    const output = (await instance.getOutput()) as { ok?: boolean; reason?: string };
    await instance.dispose();

    expect(output.ok).toBe(false);
    expect(['already_terminal', 'already_closed']).toContain(output.reason);

    const after = await store.statusRow(taskId);
    expect(after?.status).toBe('done');
    expect(after?.result).toEqual(before?.result);
    expect(await store.getOpenAwaiting(taskId)).toBeNull();
  }, 60_000);

  it('cancel извне: терминальный статус, сигнал отклоняется, fencing держит шаги', async () => {
    const { store, port } = setup();
    const taskId = nextId('cancel');

    const submit = await port.submit({ id: taskId, profileId: 'p', goal: 'отмена', awaitingPurpose: 'missing_fact' });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    const cancelled = await port.cancel(taskId, { reason: 'user pressed stop' });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.generation).toBe(submit.generation + 1);

    const row = await store.requireTask(taskId);
    expect(row.status).toBe('cancelled');
    expect(await store.getOpenAwaiting(taskId)).toBeNull();

    const late = await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: 'web:after-cancel' });
    expect(late.delivered).toBe(false);
    expect(late.reason).toBe('terminal_state');
    expect((await store.requireTask(taskId)).status).toBe('cancelled');

    // Шаг, работавший на старом поколении, отвергнут.
    await expect(store.commit(taskId, submit.generation, { status: 'done' })).rejects.toBeInstanceOf(FencedError);
  }, 60_000);
});

/**
 * Own-API dogfood (#23), шаг 1: обычный one-shot запуск НЕ требует ответа
 * человека. План не открывает ожидание, не ждёт сигнала и закрывает задачу
 * результатом движка. Ожидание — только по typed-запросу хоста (тесты выше).
 */
describe('Workflow Port: one-shot без обязательного ожидания (#23)', () => {
  it('без awaitingPurpose план не открывает ожидание и закрывает задачу сам', async () => {
    const { store, port } = setup();
    const taskId = nextId('one-shot');

    const submit = await port.submit({ id: taskId, profileId: 'p', goal: 'one-shot без ожидания' });
    expect(submit.created).toBe(true);

    const done = await pollUntil('done', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    expect(done.stage).toBe('finished');

    // Ключевое: ожидание не открывалось, сигналов не было.
    expect(await store.getOpenAwaiting(taskId)).toBeNull();
    expect(await store.listSignals(taskId)).toHaveLength(0);
    expect(done.awaiting_input_id).toBeNull();

    // Результат — от движка (здесь движка нет), а не от человека.
    const result = (await store.statusRow(taskId))?.result as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, answer: null, userAnswer: null, mode: 'no_engine' });

    // Повторный submit — тот же экземпляр, второго прохода нет.
    const second = await port.submit({ id: taskId, profileId: 'p', goal: 'one-shot без ожидания' });
    expect(second.created).toBe(false);
    expect(second.instanceCreated).toBe(false);
    expect((await store.history(taskId)).filter((e) => e.task_item_id === 'prepare')).toHaveLength(1);
  }, 60_000);
});
