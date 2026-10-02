import { TaskStore } from '../src/taskstore';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const newTask = async (store: TaskStore, id = nextId('t')) => {
  const { created, task } = await store.admitTask({
    id,
    profileId: 'profile-1',
    goal: 'проверить переходы',
    conversationId: `conv-${id}`,
  });
  expect(created).toBe(true);
  return task;
};

describe('Task Store: приём и переходы', () => {
  it('повторный приём той же задачи идемпотентен (created=false, один task_accepted)', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId('dup');
    const first = await store.admitTask({ id, profileId: 'p', goal: 'g' });
    const second = await store.admitTask({ id, profileId: 'p', goal: 'g' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(id);

    const events = await store.history(id);
    expect(events.filter((e) => e.kind === 'task_accepted')).toHaveLength(1);
  });

  it('смена статуса и её событие пишутся одной транзакцией (status=колонка, history=события)', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    const before = await store.requireTask(task.id);

    await store.commit(task.id, task.generation, {
      status: 'paused',
      step: 'pause',
      payload: { note: 'поставлено на паузу' },
    });
    await store.commit(task.id, task.generation, {
      status: 'active',
      stage: 'running',
      step: 'prepare',
      payload: { note: 'шаг начался' },
    });

    const after = await store.requireTask(task.id);
    expect(after.status).toBe('active');
    expect(after.stage).toBe('running');
    expect(after.revision).toBe(before.revision + 2);
    expect(after.generation).toBe(before.generation);

    const events = await store.history(task.id);
    const first = events.find((e) => e.task_item_id === 'pause')!;
    expect(first.kind).toBe('task_status_changed');
    expect(first.status_before).toBe('active');
    expect(first.status_after).toBe('paused');
    expect(first.generation).toBe(task.generation);
    expect(JSON.parse(first.payload_json)).toEqual({ note: 'поставлено на паузу' });

    const second = events.find((e) => e.task_item_id === 'prepare')!;
    expect(second.status_before).toBe('paused');
    expect(second.status_after).toBe('active');
  });

  it('результат шага структурированный: result_json, а не текстовый маркер', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    await store.commit(task.id, task.generation, {
      status: 'done',
      stage: 'finished',
      result: { answer: 'да', ok: true },
      step: 'finalize',
    });
    const row = await store.statusRow(task.id);
    expect(row?.status).toBe('done');
    expect(row?.stage).toBe('finished');
    expect(row?.result).toEqual({ answer: 'да', ok: true });
  });

  it('statusRow: статус + история + сигналы одним запросом (приёмка §6.1)', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    await store.commit(task.id, task.generation, { status: 'active', stage: 'running', step: 'run' });
    await store.recordSignal({ taskId: task.id, idempotencyKey: 'tg:1', eventType: 'user_reply', payload: { text: 'ok' } });

    const row = await store.statusRow(task.id);
    expect(row).not.toBeNull();
    expect(row!.history.length).toBeGreaterThanOrEqual(2);
    expect(row!.signals.length).toBe(1);
    expect(row!.conversation_id).toBe(`conv-${task.id}`);
  });

  it('запись живёт в D1, а не в процессе: новый экземпляр репозитория читает всё то же', async () => {
    const writer = new TaskStore(env.DB);
    const task = await newTask(writer);
    await writer.commit(task.id, task.generation, { status: 'active', stage: 'running', step: 'run' });

    const afterRestart = new TaskStore(env.DB);
    const row = await afterRestart.statusRow(task.id);
    expect(row?.status).toBe('active');
    expect(row?.history.length).toBe(2);
  });
});

describe('Task Store: awaiting input', () => {
  it('открытие ожидания атомарно с проекцией на задачу (status=awaiting_input, stage=waiting_input)', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);

    const { awaitingInputId } = await store.openAwaiting({
      taskId: task.id,
      kind: 'data',
      question: 'Какой ответ считать верным?',
      respondentScope: 'profile-1',
      step: 'wait',
    });

    const after = await store.requireTask(task.id);
    expect(after.status).toBe('awaiting_input');
    expect(after.stage).toBe('waiting_input');
    expect(after.awaiting_input_id).toBe(awaitingInputId);

    const open = await store.getOpenAwaiting(task.id);
    expect(open?.awaiting_input_id).toBe(awaitingInputId);
    expect(open?.status).toBe('open');

    const events = await store.history(task.id);
    expect(events.at(-1)?.kind).toBe('awaiting_opened');
  });

  it('второе открытое ожидание запрещено частично-уникальным индексом', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    await store.openAwaiting({
      taskId: task.id,
      kind: 'choice',
      question: 'Первый вопрос?',
      respondentScope: 'profile-1',
    });
    await expect(
      store.openAwaiting({
        taskId: task.id,
        kind: 'choice',
        question: 'Второй вопрос?',
        respondentScope: 'profile-1',
      }),
    ).rejects.toThrow(/already open/i);
  });

  it('ответ закрывает ожидание, снимает проекцию и возвращает статус active', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    const { awaitingInputId } = await store.openAwaiting({
      taskId: task.id,
      kind: 'data',
      question: 'Продолжить?',
      respondentScope: 'profile-1',
      step: 'wait',
    });
    const signal = await store.recordSignal({
      taskId: task.id,
      idempotencyKey: 'tg:77',
      eventType: 'user_reply',
      payload: { text: 'да' },
    });

    await store.answerAwaiting({
      taskId: task.id,
      answer: { text: 'да' },
      signalId: signal.signal.id,
      generation: task.generation,
      step: 'wait',
    });

    const after = await store.requireTask(task.id);
    expect(after.status).toBe('active');
    expect(after.stage).toBe('running');
    expect(after.awaiting_input_id).toBeNull();

    const rows = await store.listAwaiting(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('answered');
    expect(JSON.parse(rows[0]!.answer_json!)).toEqual({ text: 'да' });
    expect(rows[0]!.awaiting_input_id).toBe(awaitingInputId);

    const events = await store.history(task.id);
    expect(events.at(-1)?.kind).toBe('awaiting_answered');
  });

  it('истечение ожидания закрывает строку и переводит задачу в заданный статус', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    await store.openAwaiting({
      taskId: task.id,
      kind: 'approval',
      question: 'Подтвердить?',
      respondentScope: 'profile-1',
    });

    await store.expireAwaiting({ taskId: task.id, nextStatus: 'failed', reason: 'user_reply_timeout' });

    const after = await store.requireTask(task.id);
    expect(after.status).toBe('failed');
    expect(after.awaiting_input_id).toBeNull();
    const rows = await store.listAwaiting(task.id);
    expect(rows[0]!.status).toBe('expired');
    expect((await store.getOpenAwaiting(task.id))).toBeNull();
  });
});

describe('Task Store: conversation', () => {
  it('создание задачи создаёт строку разговора и задачи видны по conversation_id', async () => {
    const store = new TaskStore(env.DB);
    const convId = nextId('conv');
    await store.admitTask({ id: nextId('t'), profileId: 'p', goal: 'первая просьба', conversationId: convId });
    await store.admitTask({ id: nextId('t'), profileId: 'p', goal: 'вторая просьба', conversationId: convId });

    const conv = await store.getConversation(convId);
    expect(conv?.conversation_id).toBe(convId);
    expect(conv?.profile_id).toBe('p');

    const tasks = await store.tasksByConversation(convId);
    expect(tasks).toHaveLength(2);
  });
});
