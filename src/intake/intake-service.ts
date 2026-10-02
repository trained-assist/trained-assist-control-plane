/**
 * Приём задачи и durable receipt (карточка P04, контракт C01).
 *
 * Четыре разных факта не смешиваются в одном ответе (C01): квитанция ≠ запуск ≠
 * результат ≠ доставка. admit() подтверждает только durable acceptance: он не
 * запускает Run и не возвращает результат.
 *
 * Идемпотентность: повтор того же requestId с тем же payload возвращает ПРЕЖНЮЮ
 * квитанцию (duplicate=true); другой payload с тем же ключом — conflict (409).
 * Scope ключа включает проверенного вызывающего (profileId), поэтому один и тот
 * же requestId у двух профилей — разные задачи.
 */
import type { AcceptReceipt, AdmitTaskInput, TaskStore } from '../taskstore';
import { logStructured } from '../logging/structured-log';
import { authorizeIntake, resolvePrincipal, requirePermission } from './authorization';
import { EnvelopeConflictError, PrincipalForbiddenError, PrincipalUnauthorizedError } from './errors';
import { artifactRefsOf, envelopeHash, goalOf, normalizeEnvelope, type IntakeEnvelope } from './envelope';
import { defaultPilotRouter, type PilotRouter } from '../pilot';

export interface AdmitIdentity {
  /** Проверенный principalId (из аутентификации, не из тела запроса). */
  principalId: string;
}

export interface AdmitResult {
  receipt: AcceptReceipt;
  /** true = повтор того же requestId с тем же payload, возвращена прежняя квитанция. */
  duplicate: boolean;
  userTaskId: string;
  conversationId: string | null;
  /** Маршрутизация пилотом на момент приёма. */
  pilotRoute: 'new-plane' | 'legacy' | null;
  pilotReason: string | null;
}

/**
 * userTaskId детерминирован от (profileId, requestId): два параллельных приёма
 * одного и того же запроса дают ОДИН и тот же PK, и ровно один из них создаёт
 * строку задачи — без гонки между проверкой и вставкой.
 */
export async function deriveUserTaskId(profileId: string, requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${profileId}\u0000${requestId}`));
  return `ut-${[...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class IntakeService {
  constructor(
    private readonly store: TaskStore,
    private readonly pilotRouter: PilotRouter = defaultPilotRouter,
  ) {}

  async admit(identity: AdmitIdentity, rawEnvelope: unknown): Promise<AdmitResult> {
    const envelope = normalizeEnvelope(rawEnvelope);
    const declaredProfile = readDeclaredProfile(rawEnvelope);

    let principal;
    try {
      principal = await resolvePrincipal(this.store, identity);
    } catch (e) {
      logStructured({
        event: 'intake.unauthorized',
        level: 'warn',
        profileId: declaredProfile ?? null,
        requestId: envelope.requestId,
        reason: 'principal_unknown_or_disabled',
      });
      throw e;
    }
    const profileId = declaredProfile ?? principal.profileId;
    try {
      requirePermission(principal, profileId, 'tasks:intake');
    } catch (e) {
      logStructured({
        event: 'intake.forbidden',
        level: 'warn',
        profileId,
        requestId: envelope.requestId,
        reason: e instanceof PrincipalForbiddenError ? e.reason : 'permission_denied',
      });
      throw e;
    }

    const userTaskId = await deriveUserTaskId(profileId, envelope.requestId);
    const receiptId = crypto.randomUUID();
    const hash = await envelopeHash(envelope);

    const route = await this.pilotRouter.route({
      profileId,
      userTaskId,
      requestId: envelope.requestId,
      createdAt: Date.now(),
    });

    const { created, receipt } = await this.store.admitTask({
      id: userTaskId,
      profileId,
      goal: goalOf(envelope),
      projectId: envelope.projectId ?? null,
      conversationId: envelope.conversationRef ?? null,
      audienceId: envelope.audienceId ?? null,
      destinationId: envelope.destinationId ?? null,
      requestId: envelope.requestId,
      sessionId: envelope.sessionId ?? null,
      receiptId,
      envelopeHash: hash,
      envelope: {
        principalId: principal.principalId,
        contractVersion: envelope.contractVersion,
        replyToRef: envelope.replyToRef ?? null,
        artifactRefs: artifactRefsOf(envelope),
        requestedExecutionPolicy: envelope.requestedExecutionPolicy ?? null,
      },
      userValue: {
        inputItems: envelope.inputItems,
        artifactRefs: artifactRefsOf(envelope),
        pilotRoute: route.route,
        pilotReason: route.reason,
      },
    });

    if (!created) {
      // Повтор: та же задача, сохранённая квитанция. Другой payload — conflict.
      if (receipt.envelopeHash && receipt.envelopeHash !== hash) {
        logStructured({
          event: 'intake.conflict',
          level: 'warn',
          profileId,
          userTaskId,
          requestId: envelope.requestId,
          receiptId: receipt.receiptId,
          reason: 'payload_mismatch',
        });
        throw new EnvelopeConflictError(envelope.requestId, userTaskId, receipt.envelopeHash, hash);
      }
      logStructured({
        event: 'intake.duplicate',
        profileId,
        userTaskId,
        requestId: envelope.requestId,
        receiptId: receipt.receiptId,
        reason: 'same_request_id_same_payload',
      });
// Повтор: маршрут НЕ пересчитывается — берём сохранённый в user_value задачи.
      // Перероутивание опасно: задача могла уже выполняться на старом plane.
      const storedTask = await this.store.getTask(userTaskId);
      const stored = readStoredPilotRoute(storedTask?.user_value ?? null);
      return {
        receipt,
        duplicate: true,
        userTaskId,
        conversationId: envelope.conversationRef ?? null,
        pilotRoute: stored.route,
        pilotReason: stored.reason,
      };
    }

     logStructured({
       event: 'intake.accepted',
       profileId,
       userTaskId,
       requestId: envelope.requestId,
       receiptId,
       reason: 'accepted',
     });
     return { receipt, duplicate: false, userTaskId, conversationId: envelope.conversationRef ?? null, pilotRoute: route.route, pilotReason: route.reason };
  }
}

function readDeclaredProfile(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>).profileId;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Маршрут, сохранённый при первой приёме задачи. Читается на повторе
 * (duplicate), чтобы маршрут не пересчитывался: решение принимается ОДИН раз.
 */
function readStoredPilotRoute(userValue: string | null): { route: 'new-plane' | 'legacy'; reason: string } {
  if (!userValue) return { route: 'legacy', reason: 'no_stored_route' };
  try {
    const parsed = JSON.parse(userValue) as Record<string, unknown>;
    const route = parsed.pilotRoute;
    if (route === 'new-plane' || route === 'legacy') {
      const reason = parsed.pilotReason;
      return { route, reason: typeof reason === 'string' ? reason : 'stored' };
    }
  } catch {
    return { route: 'legacy', reason: 'unparseable_user_value' };
  }
  return { route: 'legacy', reason: 'no_stored_route' };
}

export type { IntakeEnvelope };
export { authorizeIntake };