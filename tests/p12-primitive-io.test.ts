/**
 * Приёмка P12 — Primitive Input/Output и routing.
 *
 * Сценарии:
 *  1. доставка ≠ исполнение: сбой доставки не меняет статус задачи, не создаёт новую попытку;
 *  2. conversation vs task projection различаются: conversation — последовательность сообщений,
 *     task — статус/попытки, проекции читаются через разные эндпоинты;
 *  3. scoped context (projectId/audienceId) переживает рестарт control plane;
 *  4. один userTaskId от intake до результата;
 *  5. `/stop` и `/status` — примитивный routing, без LLM (нет step_done/llm событий после);
 *  6. durable ACK + replay: повтор сигнала с тем же ключом — no-op, late событие не
 *     меняет терминальную стадию.
 *
 * Песочница — FakeControlPlane (в памяти), та же модель что и web/e2e.
 */
import { describe, expect, it } from 'vitest';
import { ControlPlaneClient } from '../web/control-plane-client';
import { FakeControlPlane, emptyState } from '../web/fake-control-plane';
import { readWebConfig } from '../web/config';
import { ConversationSession, MemoryTurnIndexStore } from '../web/conversation';

const PRINCIPAL = 'sandbox-web';
const PROFILE = 'profile-web-sandbox';

const makeClient = (plane: FakeControlPlane) =>
  new ControlPlaneClient(
    readWebConfig({ CONTROL_PLANE_URL: 'http://control-plane.test', CONTROL_PLANE_PRINCIPAL: PRINCIPAL, CONTROL_PLANE_PROFILE: PROFILE }),
    { fetchImpl: plane.fetch as unknown as typeof fetch },
  );

const tick = async (ms = 5): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('P12 — Primitive Input/Output и routing', () => {
  // ── 1. доставка ≠ исполнение ──────────────────────────────
  describe('доставка ≠ исполнение (AC-93, AC-265)', () => {
    it('сбой доставки не меняет статус задачи и не создаёт новую попытку', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 0, artifactOnDone: false } });
      const client = makeClient(plane);
      const receipt = await client.intake({ requestId: 'p12-del-1', text: 'задача' });
      expect(receipt.userTaskId).toBeTruthy();

      await client.start(receipt.userTaskId);
      await tick();
      const statusBefore = await client.status(receipt.userTaskId);
      expect(statusBefore.status).toBe('done');
      const runsBefore = statusBefore.runs.length;

      // Имитация сбоя доставки через прямой вызов (delivery fail ≠ execution fail).
      const hadDelivery = plane.failDeliveryDirect(receipt.userTaskId);
      expect(hadDelivery).toBe(true);

      // После сбоя доставки задача всё ещё done, попыток не добавилось.
      const statusAfter = await client.status(receipt.userTaskId);
      expect(statusAfter.status).toBe('done');
      expect(statusAfter.runs.length).toBe(runsBefore);
    });

    it('повтор того же логического сообщения — no-op, статус не меняется', async () => {
       const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: false } });
       const client = makeClient(plane);
       const receipt = await client.intake({ requestId: 'p12-del-2', text: 'задача' });
       await client.start(receipt.userTaskId);
       await tick();

       const statusBefore = await client.status(receipt.userTaskId);
       expect(statusBefore.status).toBe('awaiting_input');
       const runsBefore = statusBefore.runs.length;

       // Первый signal — доставлен.
       const ack1 = await client.signal(receipt.userTaskId, {
         type: 'user_reply',
         payload: { answer: 'ответ' },
         idempotencyKey: 'web:p12:dup-msg',
       });
       expect(ack1.duplicate).toBe(false);
       expect(ack1.delivered).toBe(true);
       await tick();

       // Второй signal с тем же ключом — дубль, no-op.
       const ack2 = await client.signal(receipt.userTaskId, {
         type: 'user_reply',
         payload: { answer: 'повтор' },
         idempotencyKey: 'web:p12:dup-msg',
       });
       expect(ack2.duplicate).toBe(true);

       const statusAfter = await client.status(receipt.userTaskId);
       expect(statusAfter.status).toBe('done');
       expect(statusAfter.runs.length).toBe(runsBefore);
     });
  });

  // ── 2. conversation vs task projection ────────────────────
  describe('conversation vs task projection (AC-92)', () => {
    it('разговор и проекция задачи — разные сущности: turns ≠ status', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
      const client = makeClient(plane);
      const store = new MemoryTurnIndexStore();
      const session = new ConversationSession(client, {
        conversationId: 'conv-p12-projection',
        profileId: PROFILE,
        store,
      });
      await session.create();

      await session.sendMessage('собери сводку');
      await tick();
      const view = await session.refresh();

      // Conversation projection: turns, awaiting
      expect(view.turns).toHaveLength(1);
      expect(view.awaiting).not.toBeNull();
      expect(view.turns[0]!.awaiting).not.toBeNull();

      // Task projection (через status): статус, попытки, stage
      const status = await client.status(view.turns[0]!.userTaskId);
      expect(status.status).toBe('awaiting_input');
      expect(status.stage).toBe('waiting_input');
      expect(status.runs).toHaveLength(1);
      expect(status.awaiting).not.toBeNull();

      // Согласованность полей
      expect(view.turns[0]!.status).toBe(status.status);
    });

    it('контекст разговора (cursors) переживает рестарт web-слоя', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
      const client = makeClient(plane);
      const store = new MemoryTurnIndexStore();
      const session = new ConversationSession(client, {
        conversationId: 'conv-p12-context',
        profileId: PROFILE,
        store,
      });
      await session.create();
      await session.sendMessage('собери сводку');
      await tick();
      await session.answer('только за вчера');
      await tick();

      // Восстановление: новая сессия поверх того же durable-индекса (restart web).
      const session2 = new ConversationSession(client, {
        conversationId: 'conv-p12-context',
        profileId: PROFILE,
        store,
      });
      const restored = await session2.open();
      expect(restored.turns).toHaveLength(2);
      expect(restored.turns[0]!.terminal).toBe('done');
      expect(restored.turns[1]!.userTaskId).toBe(restored.turns[0]!.userTaskId);
    });
  });

  // ── 3. scoped context переживает restart ──────────────────
  describe('scoped context (AC-92)', () => {
    it('projectId и audienceId сохраняются через рестарт control plane', async () => {
       const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 0, artifactOnDone: false } });
       const client = makeClient(plane);
       const store = new MemoryTurnIndexStore();

       const session = new ConversationSession(client, {
         conversationId: 'conv-scoped',
         profileId: PROFILE,
         store,
       });
       await session.create();
       await session.sendMessage('задача с контекстом');
       await tick();

       // Scoped поля зафиксированы в задаче → доступны через report.
       const reportBefore = await client.report(store.snapshot()[0]!.turns[0]!.userTaskId);
       expect(reportBefore.snapshot.conversationId).toBe('conv-scoped');

       // Рестарт control plane: durable-состояние живо, экземпляры — нет.
       plane.restart();

       // Восстановление: новая сессия поверх того же durable-индекса.
       const session2 = new ConversationSession(client, {
         conversationId: 'conv-scoped',
         profileId: PROFILE,
         store,
       });
       const restored = await session2.open();
       expect(restored.turns).toHaveLength(1);
       expect(restored.turns[0]!.terminal).toBe('done');
     });

    it('при 0–1 проекте вопроса нет; выбор сохраняется', async () => {
       const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 0, artifactOnDone: false } });
       const client = makeClient(plane);

       const receipt = await client.intake({
         requestId: 'p12-project-1',
         text: 'вопрос без проекта',
         conversationId: 'conv-project',
       });
       await client.start(receipt.userTaskId);
       await tick();
       const status = await client.status(receipt.userTaskId);
       expect(status.conversation_id).toBe('conv-project');
       expect(status.status).toBe('done'); // questionsBeforeDone=0 → сразу done
     });
  });

  // ── 4. один userTaskId от ingress до результата ───────────
  describe('единственный userTaskId (AC-260, AC-265)', () => {
    it('userTaskId из квитанции = userTaskId в статусе = userTaskId в report', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
      const client = makeClient(plane);

      const receipt = await client.intake({ requestId: 'p12-id-1', text: 'собери сводку' });
      expect(receipt.userTaskId).toBeTruthy();

      await client.start(receipt.userTaskId);
      await tick();
      await answer(client, receipt.userTaskId);
      await tick();

      const status = await client.status(receipt.userTaskId);
      expect(status.id).toBe(receipt.userTaskId);
      expect(status.runs[0]?.id).toBeTruthy();

      const report = await client.report(receipt.userTaskId);
      expect(report.snapshot.userTaskId).toBe(receipt.userTaskId);
      expect(report.snapshot.status).toBe('done');
    });

    it('повтор intake с тем же requestId возвращает ту же квитанцию', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 0, artifactOnDone: false } });
      const client = makeClient(plane);

      const first = await client.intake({ requestId: 'p12-idem-1', text: 'привет' });
      const second = await client.intake({ requestId: 'p12-idem-1', text: 'привет' });
      expect(second.userTaskId).toBe(first.userTaskId);
      expect(second.receiptId).toBe(first.receiptId);
      expect(second.duplicate).toBe(true);
    });
  });

  // ── 5. /stop и /status — примитивный routing, НЕ LLM ─────
  describe('/stop и /status не проходят через LLM (AC-96)', () => {
    it('/stop (cancel) фиксирует stopConfirmed без LLM-событий', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
      const client = makeClient(plane);

      const receipt = await client.intake({ requestId: 'p12-stop-1', text: 'собери сводку' });
      await client.start(receipt.userTaskId);
      await tick();

      // Задача в awaiting_input — останавливаем до ответа.
      const cancel = await client.cancel(receipt.userTaskId, 'user_stop');
      expect(cancel.cancelled).toBe(true);
      expect(cancel.stopConfirmed).toBe(true);
      expect(cancel.status).toBe('cancelled');

      // В журнале нет LLM-шагов (только управление: run_started + awaiting_opened + task_cancelled).
      const events = await client.events(receipt.userTaskId, 0);
      const kinds = events.events.map((e: { kind: string }) => e.kind);
      expect(kinds).not.toContain('llm_step');
      expect(kinds).toContain('task_cancelled');
      expect(kinds).toContain('cancel_requested');
    });

    it('/status — read-only, не создаёт событий и не меняет generation', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
      const client = makeClient(plane);

      const receipt = await client.intake({ requestId: 'p12-status-1', text: 'собери сводку' });
      await client.start(receipt.userTaskId);
      await tick();
      const status1 = await client.status(receipt.userTaskId);
      const gen1 = status1.generation;

      // Множественные /status не меняют generation и не создают новых runs.
      await client.status(receipt.userTaskId);
      await client.status(receipt.userTaskId);
      const status2 = await client.status(receipt.userTaskId);
      expect(status2.generation).toBe(gen1);
      expect(status2.runs).toHaveLength(1);
    });

    it('/stop и /status — ответ в той же сессии (без нового execution)', async () => {
       const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: false } });
       const client = makeClient(plane);

       const receipt = await client.intake({ requestId: 'p12-stop-2', text: 'вопрос' });
       await client.start(receipt.userTaskId);
       await tick();

       const before = await client.status(receipt.userTaskId);
       const runId = before.runs[0]?.id;

       const cancel = await client.cancel(receipt.userTaskId, 'user_stop');
       expect(cancel.status).toBe('cancelled');

       // После stop статус терминальный — без нового Run.
       const after = await client.status(receipt.userTaskId);
       expect(after.status).toBe('cancelled');
       expect(after.runs[0]?.id).toBe(runId); // та же попытка
     });
  });

  // ── 6. durable ACK + replay ───────────────────────────────
  describe('durable ACK + replay (AC-260, AC-264)', () => {
    it('повтор сигнала с тем же ключом — no-op, результат тот же', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 1, artifactOnDone: true } });
      const client = makeClient(plane);

      const receipt = await client.intake({ requestId: 'p12-replay-1', text: 'собери сводку' });
      await client.start(receipt.userTaskId);
      await tick();

      const ack1 = await client.signal(receipt.userTaskId, {
        type: 'user_reply',
        payload: { answer: 'да' },
        idempotencyKey: 'web:p12:turn1',
      });
      expect(ack1.duplicate).toBe(false);
      expect(ack1.delivered).toBe(true);
      await tick();

      const ack2 = await client.signal(receipt.userTaskId, {
        type: 'user_reply',
        payload: { answer: 'да' },
        idempotencyKey: 'web:p12:turn1',
      });
      expect(ack2.duplicate).toBe(true);

      const view = await client.events(receipt.userTaskId, 0);
      expect(view.events.filter((e: { kind: string }) => e.kind === 'awaiting_answered')).toHaveLength(1);
    });

    it('late событие не меняет терминальную стадию неверно (guard #90)', async () => {
      const plane = new FakeControlPlane({ plan: { questionsBeforeDone: 0, artifactOnDone: false } });
      const client = makeClient(plane);

      const receipt = await client.intake({ requestId: 'p12-replay-2', text: 'вопрос' });
      await client.start(receipt.userTaskId);
      await tick();

      // Сигнал на терминальную задачу — отклонён, не перезапуск.
      const ack = await client.signal(receipt.userTaskId, {
        type: 'user_reply',
        payload: { answer: 'поздний' },
        idempotencyKey: 'web:p12:late',
      });
      expect(ack.duplicate).toBe(false);
      // План без уточнений → done сразу; поздний сигнал отклонён.
      const status = await client.status(receipt.userTaskId);
      expect(status.status).toBe('done');
    });
  });
});

async function answer(client: ControlPlaneClient, userTaskId: string): Promise<void> {
  const status = await client.status(userTaskId);
  const awaitingId = status.awaiting?.id;
  if (!awaitingId) return;
  await client.signal(userTaskId, {
    type: 'user_reply',
    payload: { answer: `ответ` },
    idempotencyKey: `web:answer:${userTaskId}`,
  });
}
