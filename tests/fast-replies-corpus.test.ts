/**
 * Корпус быстрых ответов P18 → route policy P16 (AC-125/AC-126).
 *
 * Проверяются три вещи, и все три — про маршрут, а не про качество текста:
 *  1. верный маршрут на всех 35 диалогах (dev + holdout);
 *  2. НОЛЬ ложно-быстрых ответов о живых данных (`false_fast` = 0 — бюджет,
 *     назначенный до holdout, §11.9);
 *  3. файл решений воспроизводим: пересчёт даёт байт-в-байт тот же JSONL,
 *     который лежит в `eval/fast-replies/decisions/`.
 *
 * Снимок корпуса сверяется с манифестом P18: правка корпуса без пересборки
 * манифеста ломает тест (это и есть версионирование).
 */
import { describe, expect, it } from 'vitest';
import corpusText from '../eval/fast-replies/dialogs.v1.jsonl?raw';
import snapshotRaw from '../eval/fast-replies/corpus.snapshot.json';
import decisionsText from '../eval/fast-replies/decisions/p16-route-policy.v1.jsonl?raw';
import {
  CORPUS_VERSION,
  decisionRow,
  EVAL_SOURCE,
  replayDialog,
  type CorpusDialog,
} from '../src/router/corpus-replay';
import { routingDecisionEvent } from '../src/router/events';
import { routeRequest } from '../src/router/service';
import { sandboxCapabilityCatalog } from '../src/router/catalog';
import { deriveAuthorization } from '../src/router/authorization';

interface CorpusSnapshot {
  files: Record<string, { sha256: string; records: number }>;
}

const snapshot = snapshotRaw as CorpusSnapshot;

const corpusFile = snapshot.files['dialogs.v1.jsonl'] as { sha256: string; records: number };

const dialogs: CorpusDialog[] = (corpusText as string)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as CorpusDialog);

const catalog = sandboxCapabilityCatalog();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Пересчёт решений политики по корпусу: ровно то, что лежит в артефакте. */
async function regenerateDecisions(): Promise<string> {
  const lines: string[] = [];
  for (const dialog of dialogs) {
    const { decision, fault } = await replayDialog(dialog, catalog);
    lines.push(JSON.stringify(decisionRow(dialog.id, decision, fault)));
  }
  return `${lines.join('\n')}\n`;
}

describe('корпус fast-replies против route policy P16', () => {
  it('снимок корпуса совпадает с манифестом P18 (sha256 + число записей)', async () => {
    expect(await sha256Hex(corpusText)).toBe(corpusFile.sha256);
    expect(dialogs.length).toBe(corpusFile.records);
  });

  it('маршрут совпадает с корпусом на всех диалогах dev и holdout', async () => {
    const missed: string[] = [];
    for (const dialog of dialogs) {
      const { decision } = await replayDialog(dialog, catalog);
      if (decision.route !== dialog.route) {
        missed.push(`${dialog.id} [${dialog.split}] ожидали ${dialog.route}, получили ${decision.route} (${decision.reasonCode})`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('ложно-быстрых ответов о живых данных ноль (бюджет false_fast = 0)', async () => {
    const liveClasses = new Set(['live_data', 'own_data', 'effect', 'multi_step']);
    const falseFast: string[] = [];
    for (const dialog of dialogs) {
      const { decision } = await replayDialog(dialog, catalog);
      const fastReplyRoute = decision.route === 'template' || decision.route === 'deterministic';
      if (fastReplyRoute && dialog.route === 'agent' && liveClasses.has(dialog.class)) falseFast.push(dialog.id);
      // Ответ с данными не может быть разрешён, если решение само требует живых данных.
      if (decision.replyAllowed && decision.requiresFreshData) falseFast.push(`${dialog.id}: reply_allowed_with_fresh_data`);
    }
    expect(falseFast).toEqual([]);
  });

  it('файл решений воспроизводим байт-в-байт (npm run eval:fast-replies)', async () => {
    expect(await regenerateDecisions()).toBe(decisionsText);
  });

  it('событие решения содержит все ключи стенда P18', async () => {
    const required = [
      'event', 'decisionId', 'corpusCase', 'corpusVersion', 'source', 'policyVersion', 'route', 'mode',
      'reasonCode', 'needsExecutor', 'schemaOutcome', 'semanticOutcome', 'coverage', 'modelCalls',
      'latencyMs', 'usageSource', 'escalationAttempt', 'firstUsefulReplyMs', 'outcome', 'continuationRef',
      'jobRef', 'runRef',
    ];
    const { decision } = await replayDialog(dialogs[0]!, catalog);
    const event = routingDecisionEvent(decision, {
      decisionId: 'test',
      source: EVAL_SOURCE,
      corpusCase: 'FR-001',
      corpusVersion: CORPUS_VERSION,
    });
    for (const key of required) expect(Object.hasOwn(event, key), `нет ключа ${key}`).toBe(true);
  });

  it('живой путь routeRequest на корпусе не эскалирует по техническому исходу', async () => {
    const identity = {
      principalId: 'principal-corpus-live',
      profileId: 'profile-corpus',
      scopes: ['tasks:intake', 'tasks:read'],
      grantedCapabilityIds: catalog.capabilities.map((c) => c.id),
      grantedIntegrationIds: ['google-drive', 'web-search', 'documents'],
    };
    const authorization = await deriveAuthorization(identity, catalog);
    const dialog = dialogs.find((d) => d.id === 'FR-062')!; // управляемый отказ модели
    const userTurn = dialog.turns.filter((t) => t.role === 'user').at(-1)!.text ?? '';
    const result = await routeRequest(
      {
        envelope: {
          principalId: identity.principalId,
          profileId: identity.profileId,
          userTaskId: 'ut-fr062',
          conversationId: 'conv-fr062',
          catalogVersion: catalog.version,
          policyVersion: 'route-policy-v1-2026-10-04',
          budgets: { llmCallsRemaining: 2, agentAllowed: true },
          runId: null,
          requestId: 'req-fr062',
        },
        prepared: {
          text: userTurn,
          context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: false, relevantTurns: 0 },
          attachments: [],
          typedSignal: null,
          contextVersion: 'ctx-live',
          readinessSnapshotPresent: true,
        },
        catalog,
        authorization,
        hostFacts: { clockMs: Date.parse('2026-09-30T23:10:00+03:00'), connections: {}, profileFields: {}, activeTasks: [], tasksYesterday: [] },
      },
      { replyOrRoute: async () => ({ kind: 'refused', modelCalls: 1 }) },
    );
    expect(result.decision.route).toBe('llm');
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.reply).toBeNull();
    expect(result.decision.escalationAttempt).toBe(false);
    expect(result.execution.agentDispatchAttempts).toBe(0);
    expect(result.decision.reasonCode).toBe('MODEL_REFUSED');
  });
});
