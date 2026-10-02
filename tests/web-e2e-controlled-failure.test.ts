/**
 * Сквозной прогон шага 7 (M1) на песочнице: пять сообщений одной conversation,
 * awaited user input, рестарт процесса ПОСЕРЕДИНЕ, продолжение БЕЗ rerun,
 * терминальный результат и небольшой артефакт после восстановления.
 *
 * Управляемые сбои (не только happy path):
 *   F1 оборванная доставка пробуждения — ответ сохранён, экземпляр не разбужен;
 *   F2 рестарт процесса control plane посреди ожидания — тот же runId, без rerun;
 *   F3 потеря связи с исполнителем — `unknown`, не `failed`, без авто-rerun,
 *      продолжение только явной новой попыткой (новый runId, generation+1);
 *   F4 потерянный HTTP-ответ после записи сигнала — повтор с тем же ключом.
 *
 * Отчёт (`report`) — то, что попадает в PR/комментарий к #109: идентификаторы,
 * ключи событий, причины переходов. Секретов и личных данных в нём нет.
 */
import { describe, expect, it } from 'vitest';
import { ControlPlaneClient } from '../web/control-plane-client';
import { FakeControlPlane } from '../web/fake-control-plane';
import { readWebConfig } from '../web/config';
import { ConversationSession, MemoryTurnIndexStore, type ConversationView } from '../web/conversation';
import { WebApp } from '../web/app';

const PRINCIPAL = 'sandbox-web';
const PROFILE = 'profile-web-sandbox';

interface E2eReport {
  conversationId: string;
  transport: string | null;
  messages: {
    seq: number;
    kind: 'new' | 'answer';
    text: string;
    userTaskId: string;
    requestId: string;
    status: string;
    runId: string | null;
    generation: number;
    cursor: number;
    runStartedCount: number;
    answersUsed: number;
    terminal: string | null;
    artifacts: string[];
    signalKeys: string[];
    unknownOutcome: boolean;
    wakeDeliveryInterrupted: boolean;
  }[];
  restarts: number;
  runStartedByTask: Record<string, number>;
  awaitingConsumedExactlyOnce: boolean;
  noRerunAfterRestart: boolean;
  artifactRef: string | null;
  artifactBytes: string | null;
  faults: string[];
}

const makeClient = (plane: FakeControlPlane, overrides: Record<string, string> = {}) =>
  new ControlPlaneClient(
    readWebConfig({
      CONTROL_PLANE_URL: 'http://control-plane.test',
      CONTROL_PLANE_PRINCIPAL: PRINCIPAL,
      CONTROL_PLANE_PROFILE: PROFILE,
      ...overrides,
    }),
    { fetchImpl: plane.fetch as unknown as typeof fetch },
  );

const summarize = (view: ConversationView) =>
  view.turns.map((t) => ({
    seq: t.seq,
    kind: t.kind,
    text: t.text,
    userTaskId: t.userTaskId,
    requestId: `web:${view.conversationId}:m${t.seq}`,
    status: t.status,
    runId: t.currentRunId,
    generation: t.generation,
    cursor: t.cursor,
    runStartedCount: t.runStartedCount,
    answersUsed: t.answersUsed,
    terminal: t.terminal,
    artifacts: t.artifacts.map((a) => a.ref),
    signalKeys: t.signalKeys,
    unknownOutcome: t.unknownOutcome,
    wakeDeliveryInterrupted: t.wakeDeliveryInterrupted,
  }));

describe('сквозной прогон шага 7 (M1)', () => {
  it('пять сообщений, рестарт посередине, продолжение без rerun, результат и артефакт', async () => {
    const plane = new FakeControlPlane({
      plan: {
        questionsBeforeDone: 1,
        artifactOnDone: true,
        // Последнее сообщение не требует уточнения: сценарий заканчивается терминалом.
        questionsFor: (task) => (/без уточнений/.test(task.goal) ? 0 : 1),
      },
    });
    const client = makeClient(plane);
    const store = new MemoryTurnIndexStore();
    const session = new ConversationSession(client, {
      conversationId: 'conv-e2e-step7',
      profileId: PROFILE,
      store,
    });
    await session.create();

    // 1. Первое сообщение: приём -> квитанция -> запуск -> открытое ожидание.
    const m1 = await session.sendMessage('собери сводку по песочнице');
    expect(m1.duplicate).toBe(false);
    expect(m1.view.awaiting).not.toBeNull();
    const task1 = m1.view.turns[0]!.userTaskId;
    const run1 = m1.view.turns[0]!.currentRunId!;

    // 2. Ответ человека: ожидание расходуется ровно один раз, задача -> done.
    const m2 = await session.answer('только за вчера', 2);
    expect(m2.view.turns[0]!.terminal).toBe('done');
    expect(m2.view.turns[0]!.answersUsed).toBe(1);
    expect(m2.view.turns[0]!.signalKeys).toHaveLength(1);

    // 3. Второе сообщение: новая задача того же разговора, снова ожидание.
    const m3 = await session.sendMessage('выгрузи результат в файл');
    const task2 = m3.view.turns[1]!.userTaskId;
    const run2 = m3.view.turns[1]!.currentRunId!;
    expect(m3.view.awaiting).not.toBeNull();
    expect(m3.view.turns[1]!.runStartedCount).toBe(1);

    // 4. РЕСТАРТ ПРОЦЕССА ПОСЕРЕДИНЕ: durable-состояние живо, экземпляры плана — нет.
    plane.restart();
    expect(plane.hasInstance(task2)).toBe(false);

    // 5. Восстановление: тот же runId, новая попытка НЕ создаётся (нет rerun).
    await session.recover();
    const afterRestart = await session.refresh();
    expect(afterRestart.turns[1]!.currentRunId).toBe(run2);
    expect(afterRestart.turns[1]!.runStartedCount).toBe(1);
    expect(afterRestart.awaiting).not.toBeNull();

    // 6. Продолжение после рестарта: ответ расходует сохранённое ожидание один раз.
    const m4 = await session.answer('да, выгружай', 4);
    expect(m4.view.turns[1]!.terminal).toBe('done');
    expect(m4.view.turns[1]!.answersUsed).toBe(1);
    expect(m4.view.turns[1]!.signalKeys).toHaveLength(1);
    expect(m4.view.turns[1]!.artifacts).toHaveLength(1);

    // 7. Пятое сообщение: терминальный результат и артефакт без уточнений.
    const m5 = await session.sendMessage('итоговая сводка без уточнений');
    expect(m5.view.turns[2]!.terminal).toBe('done');
    expect(m5.view.turns[2]!.artifacts).toHaveLength(1);
    expect(m5.view.awaiting).toBeNull();

    // 8. Артефакт доступен через web-слой ПОСЛЕ восстановления.
    const artifactRef = m5.view.turns[2]!.artifacts[0]!.ref;
    const artifact = await client.artifact(m5.view.turns[2]!.userTaskId, artifactRef);
    expect(artifact.body.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(artifact.body)).toContain('conversation task:');

    // 9. Перезапуск web-слоя (новая сессия, тот же durable-индекс): вид
    //     восстанавливается replay'ом журнала, без единого нового запуска.
    const session2 = new ConversationSession(client, {
      conversationId: 'conv-e2e-step7',
      profileId: PROFILE,
      store,
    });
    const rebuilt = await session2.open();
    expect(rebuilt.turns.map((t) => `${t.seq}:${t.kind}`)).toEqual(['1:new', '2:answer', '3:new', '4:answer', '5:new']);
    expect(rebuilt.turns[1]!.runStartedCount).toBe(1);
    expect(rebuilt.turns[2]!.terminal).toBe('done');
    expect(rebuilt.artifacts.length).toBeGreaterThanOrEqual(1);

    const report: E2eReport = {
      conversationId: 'conv-e2e-step7',
      transport: rebuilt.transport,
      messages: summarize(rebuilt),
      restarts: plane.restarts,
      runStartedByTask: {
        [task1]: rebuilt.turns[0]!.runStartedCount,
        [task2]: rebuilt.turns[1]!.runStartedCount,
        [m5.view.turns[2]!.userTaskId]: rebuilt.turns[2]!.runStartedCount,
      },
      awaitingConsumedExactlyOnce: rebuilt.turns.every((t) => t.answersUsed <= 1),
      noRerunAfterRestart: rebuilt.turns[1]!.runStartedCount === 1,
      artifactRef,
      artifactBytes: new TextDecoder().decode(artifact.body),
      faults: ['process_restart_mid_awaiting', 'web_restart_rebuild'],
    };
    expect(report.noRerunAfterRestart).toBe(true);
    expect(report.awaitingConsumedExactlyOnce).toBe(true);
    expect(report.messages).toHaveLength(5);
    expect(report.artifactRef).toBeTruthy();
    expect(report.artifactBytes).toContain('conversation task:');
    expect(report.transport).toBe('events-endpoint');
  });

  it('F1: оборванная доставка пробуждения — ответ сохранён, повтор с тем же ключом доставляет его один раз', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    plane.setFault('dropWakeDeliveryOnce');
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId: 'conv-e2e-f1',
      profileId: PROFILE,
      store: new MemoryTurnIndexStore(),
    });
    await session.create();

    await session.sendMessage('собери сводку');
    const first = await session.answer('только за вчера', 2);
    expect(first.delivered).toBe(false);
    expect(first.view.turns[0]!.wakeDeliveryInterrupted).toBe(true);
    expect(first.view.turns[0]!.terminal).toBeNull();

    // Повтор той же формы: ключ тот же, сигнал не дублируется, ответ расходуется один раз.
    const again = await session.answer('только за вчера', 2);
    expect(again.duplicate).toBe(true);
    expect(again.view.turns[0]!.terminal).toBe('done');
    expect(again.view.turns[0]!.answersUsed).toBe(1);
    expect(again.view.turns[0]!.signalKeys).toHaveLength(1);
    expect(again.view.turns[0]!.runStartedCount).toBe(1);
  });

  it('F2: рестарт процесса посреди ожидания — тот же runId, без rerun, результат после восстановления', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const client = makeClient(plane);
    const store = new MemoryTurnIndexStore();
    const session = new ConversationSession(client, {
      conversationId: 'conv-e2e-f2',
      profileId: PROFILE,
      store,
    });
    await session.create();

    await session.sendMessage('собери сводку');
    const before = await session.refresh();
    const runId = before.turns[0]!.currentRunId!;
    expect(before.turns[0]!.runStartedCount).toBe(1);
    expect(before.awaiting).not.toBeNull();

    plane.restart();
    await session.recover();
    const after = await session.refresh();
    expect(after.turns[0]!.currentRunId).toBe(runId);
    expect(after.turns[0]!.runStartedCount).toBe(1);
    expect(after.awaiting).not.toBeNull();

    const answer = await session.answer('только за вчера', 2);
    expect(answer.view.turns[0]!.terminal).toBe('done');
    expect(answer.view.turns[0]!.runStartedCount).toBe(1);
    expect(answer.view.turns[0]!.artifacts).toHaveLength(1);
  });

  it('F3: потеря связи — unknown (не failed), без авто-rerun, продолжение явной новой попыткой', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId: 'conv-e2e-f3',
      profileId: PROFILE,
      store: new MemoryTurnIndexStore(),
    });
    await session.create();

    await session.sendMessage('собери сводку');
    const view = await session.refresh();
    const runId = view.turns[0]!.currentRunId!;
    await client.markConnectionLost(runId, 'connection_lost');

    const lost = await session.refresh();
    expect(lost.turns[0]!.unknownOutcome).toBe(true);
    expect(lost.turns[0]!.terminal).toBeNull();
    expect(lost.turns[0]!.runStartedCount).toBe(1);

    // Опрос не создаёт новую попытку: молчаливого rerun в web нет.
    await session.refresh();
    await session.refresh();
    expect((await session.refresh()).turns[0]!.runStartedCount).toBe(1);

    const continued = await session.continueUnknown(1, 'продолжить после обрыва');
    expect(continued.runId).not.toBe(runId);
    expect(continued.generation).toBeGreaterThan(1);
    expect(continued.view.turns[0]!.runStartedCount).toBe(2);
    expect(continued.view.turns[0]!.fenced).toBeGreaterThanOrEqual(1);
    expect(continued.view.turns[0]!.unknownOutcome).toBe(false);
  });

  it('F4: потерянный ответ после записи сигнала — повтор с тем же ключом не создаёт второй сигнал', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    plane.setFault('loseSignalResponseOnce');
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId: 'conv-e2e-f4',
      profileId: PROFILE,
      store: new MemoryTurnIndexStore(),
    });
    await session.create();

    await session.sendMessage('собери сводку');
    await expect(session.answer('только за вчера', 2)).rejects.toThrowError(/fetch failed/);

    const again = await session.answer('только за вчера', 2);
    expect(again.duplicate).toBe(true);
    expect(again.view.turns[0]!.terminal).toBe('done');
    expect(again.view.turns[0]!.signalKeys).toHaveLength(1);
    expect(again.view.turns[0]!.answersUsed).toBe(1);
  });

  it('сквозной прогон через HTTP-роутер: страница, форма, ответ, артефакт', async () => {
    const plane = new FakeControlPlane({
      plan: {
        questionsBeforeDone: 1,
        artifactOnDone: true,
        questionsFor: (task) => (/без уточнений/.test(task.goal) ? 0 : 1),
      },
    });
    const client = makeClient(plane);
    const app = new WebApp({ client, profileId: PROFILE, store: new MemoryTurnIndexStore() });
    const base = 'http://web.test';

    const created = await app.handle(
      new Request(`${base}/web/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'conversationId=conv-e2e-http',
      }),
    );
    expect(created.status).toBe(303);

    const post = (path: string, body: string) =>
      app.handle(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      );

    const m1 = await post('/web/conversations/conv-e2e-http/messages', 'text=собери+сводку');
    expect(m1.status).toBe(303);
    const m2 = await post('/web/conversations/conv-e2e-http/answer', 'text=только+за+вчера');
    expect(m2.status).toBe(303);
    const m3 = await post('/web/conversations/conv-e2e-http/messages', 'text=выгрузи+в+файл');
    expect(m3.status).toBe(303);
    const m4 = await post('/web/conversations/conv-e2e-http/answer', 'text=да');
    expect(m4.status).toBe(303);
    const m5 = await post('/web/conversations/conv-e2e-http/messages', 'text=итог+без+уточнений');
    expect(m5.status).toBe(303);

    const page = await app.handle(new Request(`${base}/web/conversations/conv-e2e-http`));
    expect(page.status).toBe(200);
    expect(page.body).toContain('conv-e2e-http');
    expect(page.body).toContain('готово');

    const json = (await app.handle(new Request(`${base}/web/conversations/conv-e2e-http?format=json`))).body;
    const view = JSON.parse(json) as { artifacts: { ref: string }[]; turns: { terminal: string | null }[] };
    expect(view.turns).toHaveLength(5);
    expect(view.turns.every((t) => t.terminal === 'done')).toBe(true);
    expect(view.artifacts.length).toBeGreaterThanOrEqual(1);

    const artifact = await app.handle(
      new Request(`${base}/web/conversations/conv-e2e-http/artifacts/${view.artifacts[0]!.ref}`),
    );
    expect(artifact.status).toBe(200);
    expect(artifact.body).toContain('conversation task:');
  });
});