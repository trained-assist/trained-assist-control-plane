/**
 * Web-срез против локальной песочницы control plane (`web/fake-control-plane.ts`):
 * приём и квитанция, журнал по курсору, дедуп ответа, страница разговора,
 * конфигурация только из env и отсутствие секретов в логах.
 */
import { describe, expect, it } from 'vitest';
import { ControlPlaneClient } from '../web/control-plane-client';
import { FakeControlPlane, emptyState } from '../web/fake-control-plane';
import { readWebConfig, WebConfigError } from '../web/config';
import { ConversationSession, MemoryTurnIndexStore, messageKey } from '../web/conversation';
import { WebApp } from '../web/app';
import { renderConversationPage, renderConversationText } from '../web/page';

const PRINCIPAL = 'sandbox-web';
const PROFILE = 'profile-web-sandbox';

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

const tick = async (ms = 5): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('web.config', () => {
  it('читает подключение только из env и не требует секретов в репозитории', () => {
    const config = readWebConfig({
      CONTROL_PLANE_URL: 'https://control-plane.example.workers.dev/',
      CONTROL_PLANE_PRINCIPAL: PRINCIPAL,
      CONTROL_PLANE_PROFILE: PROFILE,
    });
    expect(config.controlPlaneUrl).toBe('https://control-plane.example.workers.dev');
    expect(config.principalId).toBe(PRINCIPAL);
    expect(config.profileId).toBe(PROFILE);
    expect(config.apiKey).toBeNull();
    expect(config.eventTransport).toBe('auto');
  });

  it('падает с понятной причиной, если подключение не задано окружением', () => {
    expect(() => readWebConfig({})).toThrowError(WebConfigError);
    expect(() => readWebConfig({ CONTROL_PLANE_URL: 'http://x' })).toThrowError(/CONTROL_PLANE_PRINCIPAL/);
  });

  it('не печатает ключ доступа в логах и в отчётах', () => {
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);
    const plane = new FakeControlPlane();
    const client = new ControlPlaneClient(
      readWebConfig({
        CONTROL_PLANE_URL: 'http://control-plane.test',
        CONTROL_PLANE_PRINCIPAL: PRINCIPAL,
        CONTROL_PLANE_PROFILE: PROFILE,
        CONTROL_PLANE_API_KEY: 'super-secret-key',
      }),
      { fetchImpl: plane.fetch as unknown as typeof fetch, logSink: sink },
    );
    return client
      .intake({ requestId: 'req-log-1', text: 'привет' })
      .then(() => {
        const joined = lines.join('\n');
        expect(joined).not.toContain('super-secret-key');
        expect(joined).toContain('web.intake.accepted');
        expect(joined).toContain('req-log-1');
      });
  });
});

describe('web client против песочницы control plane', () => {
  it('принимает задачу, повтор того же ключа возвращает ту же квитанцию', async () => {
    const plane = new FakeControlPlane();
    const client = makeClient(plane);
    const first = await client.intake({ requestId: 'req-1', text: 'собери сводку' });
    expect(first.duplicate).toBe(false);
    expect(first.durable).toBe(true);
    expect(first.userTaskId).toBeTruthy();

    const second = await client.intake({ requestId: 'req-1', text: 'собери сводку' });
    expect(second.duplicate).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.userTaskId).toBe(first.userTaskId);
    expect(plane.task(first.userTaskId)!.run_started_count).toBe(0);
  });

  it('читает журнал по курсору: повторное чтение не возвращает старые события', async () => {
    const plane = new FakeControlPlane();
    const client = makeClient(plane);
    const receipt = await client.intake({ requestId: 'req-cursor', text: 'курсор' });
    await client.start(receipt.userTaskId);
    await tick();

    const first = await client.events(receipt.userTaskId, 0);
    expect(first.events.length).toBeGreaterThan(0);
    const cursor = first.nextCursor ?? 0;
    expect(cursor).toBeGreaterThan(0);

    const second = await client.events(receipt.userTaskId, cursor);
    expect(second.events).toEqual([]);
    expect(second.nextCursor).toBe(cursor);
  });

  it('не делает автоматических повторов и не перезапускает задачу сам', async () => {
    const plane = new FakeControlPlane();
    const client = makeClient(plane);
    const receipt = await client.intake({ requestId: 'req-no-retry', text: 'без повторов' });
    await client.start(receipt.userTaskId);
    await tick();

    // Сигнал в терминальную задачу отклоняется, а не будит план заново.
    await client.signal(receipt.userTaskId, {
      type: 'user_reply',
      payload: { answer: 'да' },
      idempotencyKey: 'web:conv:m1',
    });
    await tick();
    const status = await client.status(receipt.userTaskId);
    expect(status.runs).toHaveLength(1);
    expect(plane.task(receipt.userTaskId)!.run_started_count).toBe(1);
  });

  it('показывает потерю связи как unknown, а не failed, и не создаёт вторую попытку', async () => {
    const plane = new FakeControlPlane();
    const client = makeClient(plane);
    const receipt = await client.intake({ requestId: 'req-unknown', text: 'обрыв' });
    await client.start(receipt.userTaskId);
    await tick();
    const runId = (await client.status(receipt.userTaskId)).runs[0]!.id;

    await client.markConnectionLost(runId, 'connection_lost');
    const status = await client.status(receipt.userTaskId);
    expect(status.runs[0]!.status).toBe('unknown');
    expect(status.status).not.toBe('failed');
    expect(status.runs).toHaveLength(1);
  });
});

describe('web conversation page', () => {
  const openSession = async (plane: FakeControlPlane, conversationId: string) => {
    const store = new MemoryTurnIndexStore();
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId,
      profileId: PROFILE,
      store,
    });
    await session.create();
    return { session, store, client };
  };

  it('пять сообщений одной conversation: уточнение, дедуп ответа, результат и артефакт', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const { session } = await openSession(plane, 'conv-page-1');

    const first = await session.sendMessage('собери сводку по песочнице');
    expect(first.duplicate).toBe(false);
    expect(first.view.turns).toHaveLength(1);
    expect(first.view.awaiting).not.toBeNull();
    expect(first.view.awaiting!.question).toContain('Уточнение');

    // Двойная отправка того же сообщения: та же квитанция, ни одной новой задачи.
    const again = await session.sendMessage('собери сводку по песочнице', 1);
    expect(again.duplicate).toBe(true);
    expect(again.view.turns).toHaveLength(1);

    const answer = await session.answer('только за вчера');
    expect(answer.duplicate).toBe(false);
    expect(answer.view.awaiting).toBeNull();
    expect(answer.view.turns[0]!.terminal).toBe('done');
    expect(answer.view.turns[0]!.artifacts).toHaveLength(1);

    // Двойной ответ в то же ожидание: ключ тот же, сигнал не дублируется.
    const second = await session.sendMessage('выгрузи в файл');
    expect(second.view.awaiting).not.toBeNull();
    const answerAgain = await session.answer('да, выгружай', 4);
    expect(answerAgain.view.turns[1]!.terminal).toBe('done');
    expect(answerAgain.view.turns[1]!.artifacts).toHaveLength(1);
    expect(answerAgain.view.turns[1]!.signalKeys).toHaveLength(1);

    const view = await session.refresh();
    expect(view.turns.map((t) => `${t.seq}:${t.kind}`)).toEqual(['1:new', '2:answer', '3:new', '4:answer']);
    expect(view.turns).toHaveLength(4);
    expect(view.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(view.transport).toBe('events-endpoint');
  });

  it('рендерит страницу с формой ответа, ссылкой на артефакт и без секретов', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const { session } = await openSession(plane, 'conv-page-2');
    await session.sendMessage('сделай выгрузку');
    const open = await session.refresh();
    const form = renderConversationPage(open);
    expect(form).toContain('conv-page-2');
    expect(form).toContain('Нужно ваше уточнение');
    expect(form).toContain(messageKey('conv-page-2', 2));
    expect(form).not.toContain('super-secret');

    await session.answer('да, выгружай', 2);
    const view = await session.refresh();
    const page = renderConversationPage(view);
    expect(page).toContain('/web/conversations/conv-page-2/artifacts/');
    expect(page).not.toContain('Нужно ваше уточнение');
    expect(renderConversationText(view)).toContain('awaiting');
  });

  it('роутер отдаёт HTML по GET и 303 после POST, а артефакт — байты', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const client = makeClient(plane);
    const app = new WebApp({ client, profileId: PROFILE, store: new MemoryTurnIndexStore() });

    const createdConv = await app.handle(
      new Request('http://web.test/web/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'conversationId=conv-router',
      }),
    );
    expect(createdConv.status).toBe(303);

    const created = await app.handle(
      new Request('http://web.test/web/conversations/conv-router/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'text=собери+сводку',
      }),
    );
    expect(created.status).toBe(303);
    expect(created.location).toBe('/web/conversations/conv-router');

    const page = await app.handle(new Request('http://web.test/web/conversations/conv-router'));
    expect(page.status).toBe(200);
    expect(page.contentType).toContain('text/html');
    expect(page.body).toContain('conv-router');

    const answered = await app.handle(
      new Request('http://web.test/web/conversations/conv-router/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'text=да',
      }),
    );
    expect(answered.status).toBe(303);

    await tick();
    const view = await app.handle(
      new Request('http://web.test/web/conversations/conv-router?format=json'),
    );
    const parsed = JSON.parse(view.body) as { artifacts: { ref: string }[] };
    expect(parsed.artifacts.length).toBeGreaterThanOrEqual(1);

    const artifact = await app.handle(
      new Request(`http://web.test/web/conversations/conv-router/artifacts/${parsed.artifacts[0]!.ref}`),
    );
    expect(artifact.status).toBe(200);
    expect(artifact.contentType).toContain('text/plain');
    expect(artifact.body).toContain('conversation task:');
  });

  it('отвечает 404 на неизвестный разговор и 409 на ответ без открытого ожидания', async () => {
    // План без уточнений: после сообщения открытого ожидания нет.
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 0, artifactOnDone: true } });
    const client = makeClient(plane);
    const app = new WebApp({ client, profileId: PROFILE, store: new MemoryTurnIndexStore() });

    const missing = await app.handle(new Request('http://web.test/web/conversations/conv-absent'));
    expect(missing.status).toBe(404);

    const createdConv = await app.handle(
      new Request('http://web.test/web/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'conversationId=conv-noawait',
      }),
    );
    expect(createdConv.status).toBe(303);

    const created = await app.handle(
      new Request('http://web.test/web/conversations/conv-noawait/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'text=привет',
      }),
    );
    expect(created.status).toBe(303);
    await tick();
    const noAwait = await app.handle(
      new Request('http://web.test/web/conversations/conv-noawait/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'text=ответ',
      }),
    );
    expect(noAwait.status).toBe(409);
  });
});

describe('web против песочницы без /events (fallback на /status)', () => {
  it('читает журнал через историю /status и помечает транспорт в отчёте', async () => {
    const plane = new FakeControlPlane();
    const client = makeClient(plane, { WEB_EVENT_TRANSPORT: 'status-history' });
    const receipt = await client.intake({ requestId: 'req-fallback', text: 'фолбэк' });
    await client.start(receipt.userTaskId);
    await tick();

    const page = await client.events(receipt.userTaskId, 0);
    expect(page.events.length).toBeGreaterThan(0);
    expect(client.eventTransport).toBe('status-history');

    const session = new ConversationSession(client, {
      conversationId: 'conv-fallback',
      profileId: PROFILE,
      store: new MemoryTurnIndexStore(),
    });
    await session.create();
    await session.sendMessage('ещё одно сообщение');
    const view = await session.refresh();
    expect(view.transport).toBe('status-history');
    expect(view.transportNote).toContain('/status');
  });
});

describe('песочница: управляемые сбои', () => {
  it('оборванная доставка пробуждения: ответ сохранён, повтор с тем же ключом доставляет его один раз', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    plane.setFault('dropWakeDeliveryOnce');
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId: 'conv-fault-wake',
      profileId: PROFILE,
      store: new MemoryTurnIndexStore(),
    });
    await session.create();

    await session.sendMessage('собери сводку');
    const first = await session.answer('только за вчера', 2);
    expect(first.delivered).toBe(false);
    expect(first.view.turns[0]!.wakeDeliveryInterrupted).toBe(true);
    expect(first.view.turns[0]!.terminal).toBeNull();

    // Повтор с тем же ключом сообщения: сигнал не дублируется, ответ расходуется один раз.
    const again = await session.answer('только за вчера', 2);
    expect(again.duplicate).toBe(true);
    expect(again.view.turns[0]!.terminal).toBe('done');
    expect(again.view.turns[0]!.answersUsed).toBe(1);
    expect(again.view.turns[0]!.signalKeys).toHaveLength(1);
  });

  it('потерянный ответ после записи сигнала: повтор с тем же ключом не создаёт второй сигнал', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    plane.setFault('loseSignalResponseOnce');
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId: 'conv-fault-response',
      profileId: PROFILE,
      store: new MemoryTurnIndexStore(),
    });
    await session.create();

    await session.sendMessage('собери сводку');
    await expect(session.answer('только за вчера')).rejects.toThrowError(/fetch failed/);

    const again = await session.answer('только за вчера', 2);
    expect(again.duplicate).toBe(true);
    expect(again.view.turns[0]!.terminal).toBe('done');
    expect(again.view.turns[0]!.signalKeys).toHaveLength(1);
  });

  it('рестарт процесса посреди ожидания: тот же runId, без rerun, результат после восстановления', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const client = makeClient(plane);
    const store = new MemoryTurnIndexStore();
    const session = new ConversationSession(client, {
      conversationId: 'conv-restart',
      profileId: PROFILE,
      store,
    });
    await session.create();

    await session.sendMessage('собери сводку');
    const before = await session.refresh();
    const runId = before.turns[0]!.currentRunId;
    expect(runId).toBeTruthy();
    expect(before.turns[0]!.runStartedCount).toBe(1);
    expect(before.awaiting).not.toBeNull();

    // Рестарт процесса control plane: durable-состояние живо, экземпляры плана — нет.
    plane.restart();
    expect(plane.hasInstance(before.turns[0]!.userTaskId)).toBe(false);

    // Подъём прерванных экземпляров: тот же runId, новая попытка не создаётся.
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

  it('потеря связи посреди работы: unknown, без авто-rerun, продолжение — явная новая попытка', async () => {
    const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
    const client = makeClient(plane);
    const session = new ConversationSession(client, {
      conversationId: 'conv-unknown',
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
    expect(lost.turns[0]!.runStartedCount).toBe(1);
    expect(lost.turns[0]!.terminal).toBeNull();

    // Никаких автоматических попыток: опрос не создаёт новую попытку.
    await session.refresh();
    expect((await session.refresh()).turns[0]!.runStartedCount).toBe(1);

    const continued = await session.continueUnknown(1, 'продолжить после обрыва');
    expect(continued.runId).not.toBe(runId);
    expect(continued.generation).toBeGreaterThan(1);
    expect(continued.view.turns[0]!.runStartedCount).toBe(2);
    expect(continued.view.turns[0]!.fenced).toBeGreaterThanOrEqual(1);
  });
});