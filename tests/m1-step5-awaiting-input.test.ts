// Эпик #109 шаг 5 «Conversation и Awaiting user input», гейт #115:
//  - durable ожидание с ЯВНЫМ awaitingInputId и дедупом ответа;
//  - ожидание переживает смерть движка (wait и ответ лежат в Task Store);
//  - продолжение ЯВНОЕ: новый runId, тот же userTaskId, доступные данные;
//  - purpose -> kind маппинг (второго набора терминов нет);
//  - пробуждение движка НЕ единственная копия ответа.
import { abortAllDurableObjects } from 'cloudflare:test';
import { AnswerConflictError, AnswerRejectedError, TaskStore } from '../src/taskstore';
import { AWAITING_PURPOSES, kindForPurpose, purposesForKind } from '../src/awaiting/purpose';
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

describe('Шаг 5: purpose -> kind (маппинг, без второго набора терминов)', () => {
  it('таблица маппинга полна и kind остаётся лексикой A2', () => {
    expect(kindForPurpose('preference')).toBe('choice');
    expect(kindForPurpose('missing_fact')).toBe('data');
    expect(kindForPurpose('credential')).toBe('approval');
    expect(kindForPurpose('approval')).toBe('approval');
    expect(kindForPurpose(null, 'data')).toBe('data');
    for (const purpose of AWAITING_PURPOSES) {
      expect(['data', 'choice', 'approval']).toContain(kindForPurpose(purpose));
      expect(purposesForKind(kindForPurpose(purpose))).toContain(purpose);
    }
  });

  it('ожидание хранит purpose и производный kind; варианты со стабильными option ID (#115)', async () => {
    const { store, port } = setup();
    const taskId = nextId('purpose');
    await port.submit({ id: taskId, profileId: 'profile-1', goal: 'выбор проекта' });
    await pollUntil('awaiting', async () => store.getOpenAwaiting(taskId));

    const open = (await store.getOpenAwaiting(taskId))!;
    // По умолчанию план спрашивает факт (missing_fact -> data).
    expect(open.purpose).toBe('missing_fact');
    expect(open.kind).toBe('data');

    const second = nextId('purpose-choice');
    await port.submit({
      id: second,
      profileId: 'profile-1',
      goal: 'выбор',
      awaitingPurpose: 'preference',
      awaitingOptions: [
        { id: 'opt-a', label: 'Вариант А' },
        { id: 'opt-b', label: 'Вариант Б' },
      ],
    });
    await pollUntil('awaiting choice', async () => store.getOpenAwaiting(second));
    const choice = (await store.getOpenAwaiting(second))!;
    expect(choice.purpose).toBe('preference');
    expect(choice.kind).toBe('choice');
    expect(JSON.parse(choice.schema_json!)).toEqual({
      options: [
        { id: 'opt-a', label: 'Вариант А' },
        { id: 'opt-b', label: 'Вариант Б' },
      ],
    });
  });
});

describe('Шаг 5: ответ по явному awaitingInputId с дедупом', () => {
  const parked = async () => {
    const { store, port } = setup();
    const taskId = nextId('answer');
    await port.submit({ id: taskId, profileId: 'profile-1', goal: 'дождись ответа' });
    await pollUntil('awaiting', async () => store.getOpenAwaiting(taskId));
    const awaiting = (await store.getOpenAwaiting(taskId))!;
    return { store, port, taskId, awaiting };
  };

  it('первый ответ применяется, повтор того же ключа = no-op с прежним результатом', async () => {
    const { store, taskId, awaiting } = await parked();

    const first = await store.answerAwaitingById({
      awaitingInputId: awaiting.awaiting_input_id,
      idempotencyKey: 'web:msg-1',
      answer: { answer: 'да' },
    });
    expect(first.applied).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.answer).toEqual({ answer: 'да' });

    const second = await store.answerAwaitingById({
      awaitingInputId: awaiting.awaiting_input_id,
      idempotencyKey: 'web:msg-1',
      answer: { answer: 'да' },
    });
    expect(second.applied).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.answer).toEqual({ answer: 'да' });
    expect(second.answeredAt).toBe(first.answeredAt);

    // Одна строка сигнала-ответа, одно событие awaiting_answered.
    expect(await store.listSignals(taskId)).toHaveLength(1);
    const answered = (await store.history(taskId)).filter((e) => e.kind === 'awaiting_answered');
    expect(answered).toHaveLength(1);
    expect((await store.getAwaiting(awaiting.awaiting_input_id))!.status).toBe('answered');
  });

  it('другой ключ на отвеченном ожидании = conflict (не второй ответ)', async () => {
    const { store, awaiting } = await parked();
    await store.answerAwaitingById({
      awaitingInputId: awaiting.awaiting_input_id,
      idempotencyKey: 'web:msg-1',
      answer: { answer: 'да' },
    });
    await expect(
      store.answerAwaitingById({
        awaitingInputId: awaiting.awaiting_input_id,
        idempotencyKey: 'web:msg-2',
        answer: { answer: 'нет' },
      }),
    ).rejects.toBeInstanceOf(AnswerConflictError);
    expect((await store.getAwaiting(awaiting.awaiting_input_id))!.answer_json).toContain('да');
  });

  it('поздний ответ после отмены отклоняется и задачу не возобновляет', async () => {
    const { store, port, taskId, awaiting } = await parked();
    const cancelled = await port.cancel(taskId, { reason: 'user pressed stop' });
    expect(cancelled.cancelled).toBe(true);

    await expect(
      store.answerAwaitingById({
        awaitingInputId: awaiting.awaiting_input_id,
        idempotencyKey: 'web:late',
        answer: { answer: 'да' },
      }),
    ).rejects.toBeInstanceOf(AnswerRejectedError);

    const task = await store.requireTask(taskId);
    expect(task.status).toBe('cancelled');
    expect(await store.getOpenAwaiting(taskId)).toBeNull();
    expect((await store.getAwaiting(awaiting.awaiting_input_id))!.status).toBe('cancelled');
  });
});

describe('Шаг 5: ожидание переживает смерть движка', () => {
  it('смерть движка после регистрации wait: ответ переживает, продолжение ЯВНОЕ', async () => {
    const { store, port } = setup();
    const taskId = nextId('death');
    const submit = await port.submit({ id: taskId, profileId: 'profile-1', goal: 'умри во время ожидания' });
    await pollUntil('awaiting', async () => store.getOpenAwaiting(taskId));
    const awaiting = (await store.getOpenAwaiting(taskId))!;

    // Движок умер: in-memory состояние экземпляра потеряно.
    await abortAllDurableObjects();

    // Ожидание живо в Task Store — оно не в процессе.
    const stillOpen = await store.getOpenAwaiting(taskId);
    expect(stillOpen?.awaiting_input_id).toBe(awaiting.awaiting_input_id);

    // Ответ приходит ПОСЛЕ смерти движка: durable, по явному адресу.
    const answered = await store.answerAwaitingById({
      awaitingInputId: awaiting.awaiting_input_id,
      idempotencyKey: 'web:after-death',
      answer: { answer: 'да' },
    });
    expect(answered.applied).toBe(true);
    expect((await store.getOpenAwaiting(taskId))).toBeNull();

    // Продолжение ЯВЛЬНОЕ: новый runId, тот же userTaskId, поколение поднято,
    // шаги до ожидания НЕ переигрываются.
    const resumed = await port.resume(taskId, { reason: 'engine died' });
    expect(resumed.runId).not.toBe(submit.runId);
    expect(resumed.generation).toBe(submit.generation + 1);

    const runStarted = (await store.history(taskId))
      .filter((e) => e.kind === 'run_started')
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
    const continuation = runStarted.find((p) => p.resumed === true)!;
    expect(continuation.runId).toBe(resumed.runId);
    expect(continuation.previousRunId ?? null).toBe(null); // прежний runId в параметре не передавался
    expect(continuation.availableData).toBeDefined();

    await pollUntil('done после продолжения', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });

    // Шаг prepare выполнен ОДИН раз: продолжение не переиграло начало задачи.
    const prepareEvents = (await store.history(taskId)).filter((e) => e.task_item_id === 'prepare');
    expect(prepareEvents).toHaveLength(1);
    const awaitingOpened = (await store.history(taskId)).filter((e) => e.kind === 'awaiting_opened');
    expect(awaitingOpened).toHaveLength(1);

    const result = await store.statusRow(taskId);
    expect(result?.result).toEqual({ answer: 'да', ok: true, version: PLAN_VERSION });
    const runs = await store.listRuns(taskId);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === submit.runId)?.status).toBe('running');
    expect(runs.find((r) => r.id === resumed.runId)?.status).toBe('success');
  }, 90_000);

  it('пробуждение движка не единственная копия ответа: потеря собыдения не теряет ответ', async () => {
    const { store, port } = setup();
    const taskId = nextId('no-event');
    const submit = await port.submit({
      id: taskId,
      profileId: 'profile-1',
      goal: 'ответ без события',
      waitPollSec: 1,
    });
    await pollUntil('awaiting', async () => store.getOpenAwaiting(taskId));
    const awaiting = (await store.getOpenAwaiting(taskId))!;

    // Ответ сохраняется БЕЗ отправки события движку (обрыв до wake).
    await store.answerAwaitingById({
      awaitingInputId: awaiting.awaiting_input_id,
      idempotencyKey: 'web:no-wake',
      answer: { answer: 'да' },
    });

    // Продолжение не зависит от потерянного пробуждения: читает durable ответ.
    const resumed = await port.resume(taskId, { reason: 'lost wake' });
    await pollUntil('done без wake-события', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    expect((await store.statusRow(taskId))?.result).toEqual({
      answer: 'да',
      ok: true,
      version: PLAN_VERSION,
    });
    expect(resumed.runId).not.toBe(submit.runId);
  }, 90_000);

  it('ранний ответ (сразу после открытия wait) не ждёт движок', async () => {
    const { store, port } = setup();
    const taskId = nextId('early');
    const submit = await port.submit({ id: taskId, profileId: 'profile-1', goal: 'ранний ответ' });
    await pollUntil('awaiting', async () => store.getOpenAwaiting(taskId));
    const awaiting = (await store.getOpenAwaiting(taskId))!;

    await store.answerAwaitingById({
      awaitingInputId: awaiting.awaiting_input_id,
      idempotencyKey: 'web:early',
      answer: { answer: 'да' },
    });

    // Продолжение сразу читает ответ: без ожидания события.
    await port.resume(taskId, { reason: 'answer already durable' });
    await pollUntil('done после раннего ответа', async () => {
      const row = await store.requireTask(taskId);
      return row.status === 'done' ? row : null;
    });
    const events = await store.history(taskId);
    // Ни одного пробуждения: ответ прочитан из durable состояния.
    expect(events.filter((e) => e.kind === 'step_woken')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'awaiting_answered')).toHaveLength(1);
  }, 90_000);
});

describe('Шаг 5: доступные данные продолжения', () => {
  it('availableContinuationData перечисляет ожидание, артефакты и результат', async () => {
    const { store, port } = setup();
    const taskId = nextId('available');
    await port.submit({ id: taskId, profileId: 'profile-1', goal: 'доступные данные' });
    await pollUntil('awaiting', async () => store.getOpenAwaiting(taskId));

    await store.recordArtifact({
      taskId,
      kind: 'file',
      artifactRef: `r2://control-plane/${taskId}/input.md`,
      sizeBytes: 128,
    });

    const available = await store.availableContinuationData(taskId);
    expect(available.awaitingInputId).toBeTruthy();
    expect(available.awaitingStatus).toBe('open');
    expect(available.awaitingPurpose).toBe('missing_fact');
    expect(available.artifacts).toEqual([`r2://control-plane/${taskId}/input.md`]);
    expect(available.resultJson).toBeNull();

    const event = (await store.history(taskId)).find((e) => e.kind === 'run_started')!;
    expect(event).toBeDefined();
  });
});
