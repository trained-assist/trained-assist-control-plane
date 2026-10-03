/**
 * Хранилище GTD в D1 (миграция 0007).
 *
 * Тонкое, как и ScheduleStore (P22): только durable-факты и дедуп. Правила
 * («одна запись на задачу», «caps завершают прогрессию», «один владелец
 * продолжения») живут в GtdService и в ограничениях схемы, а не в SQL.
 */
import type { GtdConditionRow, GtdOutcomeRow, GtdProgressionRow, GtdRecordRow } from './types';

const RECORD_COLUMNS = `gtd_id, profile_id, user_task_id, registration_reason, criteria_json,
    continuation_owner, state, stop_reason, next_trigger_kind, next_trigger_ref, next_check_at,
    deadline_at, max_attempts, attempts, current_step_id, control_generation, supervised_by_gtd_id,
    last_outcome, created_at, updated_at, revision`;

const OUTCOME_COLUMNS = `outcome_id, gtd_id, profile_id, user_task_id, run_id, step_id, outcome,
    detail_json, event_id, idempotency_key, state, reason, attempt, created_at, updated_at, acked_at`;

const PROGRESSION_COLUMNS = `progression_id, gtd_id, user_task_id, attempt, step_id, decision,
    reason, trigger_kind, trigger_ref, outcome_id, continuation_run_id, created_at`;

const CONDITION_COLUMNS = `condition_ref, gtd_id, user_task_id, conclusion, report_ref, source, created_at`;

export class GtdStore {
  constructor(private readonly db: D1Database) {}

  // ------------------------------------------------------------- записи контроля

  async insertRecord(r: GtdRecordRow): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO gtd_records(${RECORD_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(gtd_id) DO NOTHING`,
      )
      .bind(
        r.gtd_id,
        r.profile_id,
        r.user_task_id,
        r.registration_reason,
        r.criteria_json,
        r.continuation_owner,
        r.state,
        r.stop_reason,
        r.next_trigger_kind,
        r.next_trigger_ref,
        r.next_check_at,
        r.deadline_at,
        r.max_attempts,
        r.attempts,
        r.current_step_id,
        r.control_generation,
        r.supervised_by_gtd_id,
        r.last_outcome,
        r.created_at,
        r.updated_at,
        r.revision,
      )
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async getRecord(gtdId: string): Promise<GtdRecordRow | null> {
    return this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM gtd_records WHERE gtd_id = ?`).bind(gtdId).first<GtdRecordRow>();
  }

  async recordByTask(userTaskId: string): Promise<GtdRecordRow | null> {
    return this.db
      .prepare(`SELECT ${RECORD_COLUMNS} FROM gtd_records WHERE user_task_id = ?`)
      .bind(userTaskId)
      .first<GtdRecordRow>();
  }

  async listRecords(profileId?: string): Promise<GtdRecordRow[]> {
    const sql = profileId
      ? `SELECT ${RECORD_COLUMNS} FROM gtd_records WHERE profile_id = ? ORDER BY created_at`
      : `SELECT ${RECORD_COLUMNS} FROM gtd_records ORDER BY created_at`;
    const stmt = profileId ? this.db.prepare(sql).bind(profileId) : this.db.prepare(sql);
    return (await stmt.all<GtdRecordRow>()).results;
  }

  /**
   * Записи, у которых наступила плановая проверка (next_check_at <= now) или
   * которые ждут события. Тик читает только их: ожидание не будит ничего.
   */
  async dueRecords(now: number, profileId?: string): Promise<GtdRecordRow[]> {
    const sql = profileId
      ? `SELECT ${RECORD_COLUMNS} FROM gtd_records
         WHERE state IN ('active','awaiting_user','waiting_condition') AND profile_id = ?
           AND (next_check_at IS NULL OR next_check_at <= ?)
         ORDER BY next_check_at LIMIT 200`
      : `SELECT ${RECORD_COLUMNS} FROM gtd_records
         WHERE state IN ('active','awaiting_user','waiting_condition')
           AND (next_check_at IS NULL OR next_check_at <= ?)
         ORDER BY next_check_at LIMIT 200`;
    const stmt = profileId ? this.db.prepare(sql).bind(profileId, now) : this.db.prepare(sql).bind(now);
    return (await stmt.all<GtdRecordRow>()).results;
  }

  async updateRecord(
    gtdId: string,
    patch: Partial<Pick<GtdRecordRow, 'state' | 'stop_reason' | 'next_trigger_kind' | 'next_trigger_ref' | 'next_check_at' | 'attempts' | 'current_step_id' | 'last_outcome'>>,
    now: number,
  ): Promise<GtdRecordRow | null> {
    await this.db
      .prepare(
        `UPDATE gtd_records SET
            state = COALESCE(?, state), stop_reason = COALESCE(?, stop_reason),
            next_trigger_kind = COALESCE(?, next_trigger_kind),
            next_trigger_ref = COALESCE(?, next_trigger_ref),
            next_check_at = COALESCE(?, next_check_at),
            attempts = COALESCE(?, attempts), current_step_id = COALESCE(?, current_step_id),
            last_outcome = COALESCE(?, last_outcome), updated_at = ?, revision = revision + 1
         WHERE gtd_id = ?`,
      )
      .bind(
        patch.state ?? null,
        patch.stop_reason ?? null,
        patch.next_trigger_kind ?? null,
        patch.next_trigger_ref ?? null,
        patch.next_check_at ?? null,
        patch.attempts ?? null,
        patch.current_step_id ?? null,
        patch.last_outcome ?? null,
        now,
        gtdId,
      )
      .run();
    return this.getRecord(gtdId);
  }

  // ------------------------------------------------------------------- inbox

  async insertOutcome(o: GtdOutcomeRow): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO gtd_outcomes(${OUTCOME_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(gtd_id, idempotency_key) DO NOTHING`,
      )
      .bind(
        o.outcome_id,
        o.gtd_id,
        o.profile_id,
        o.user_task_id,
        o.run_id,
        o.step_id,
        o.outcome,
        o.detail_json,
        o.event_id,
        o.idempotency_key,
        o.state,
        o.reason,
        o.attempt,
        o.created_at,
        o.updated_at,
        o.acked_at,
      )
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async getOutcome(outcomeId: string): Promise<GtdOutcomeRow | null> {
    return this.db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM gtd_outcomes WHERE outcome_id = ?`).bind(outcomeId).first<GtdOutcomeRow>();
  }

  async outcomeByIdempotencyKey(gtdId: string, idempotencyKey: string): Promise<GtdOutcomeRow | null> {
    return this.db
      .prepare(`SELECT ${OUTCOME_COLUMNS} FROM gtd_outcomes WHERE gtd_id = ? AND idempotency_key = ?`)
      .bind(gtdId, idempotencyKey)
      .first<GtdOutcomeRow>();
  }

  async pendingOutcomes(gtdId: string): Promise<GtdOutcomeRow[]> {
    const res = await this.db
      .prepare(`SELECT ${OUTCOME_COLUMNS} FROM gtd_outcomes WHERE gtd_id = ? AND state = 'pending' ORDER BY created_at`)
      .bind(gtdId)
      .all<GtdOutcomeRow>();
    return res.results;
  }

  async listOutcomes(gtdId: string): Promise<GtdOutcomeRow[]> {
    const res = await this.db
      .prepare(`SELECT ${OUTCOME_COLUMNS} FROM gtd_outcomes WHERE gtd_id = ? ORDER BY created_at`)
      .bind(gtdId)
      .all<GtdOutcomeRow>();
    return res.results;
  }

  /**
   * ACK исхода: pending -> acked/rejected одной строкой с условием по состоянию.
   * Повторный проход по тому же исходу не находит его в pending — это и есть
   * идемпотентность «Output освобождает исход после durable GTD ACK».
   */
  async ackOutcome(
    outcomeId: string,
    patch: { state: 'acked' | 'rejected' | 'quarantined'; reason: string | null; attempt: number | null },
    now: number,
  ): Promise<GtdOutcomeRow | null> {
    const res = await this.db
      .prepare(
        `UPDATE gtd_outcomes SET state = ?, reason = ?, attempt = ?, acked_at = ?, updated_at = ?
         WHERE outcome_id = ? AND state = 'pending'`,
      )
      .bind(patch.state, patch.reason, patch.attempt, now, now, outcomeId)
      .run();
    if ((res.meta.changes ?? 0) !== 1) return this.getOutcome(outcomeId);
    return this.getOutcome(outcomeId);
  }

  // ------------------------------------------------------------- прогрессия

  async insertProgression(p: GtdProgressionRow): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO gtd_progressions(${PROGRESSION_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(gtd_id, step_id, attempt) DO NOTHING`,
      )
      .bind(
        p.progression_id,
        p.gtd_id,
        p.user_task_id,
        p.attempt,
        p.step_id,
        p.decision,
        p.reason,
        p.trigger_kind,
        p.trigger_ref,
        p.outcome_id,
        p.continuation_run_id,
        p.created_at,
      )
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async listProgressions(gtdId: string): Promise<GtdProgressionRow[]> {
    const res = await this.db
      .prepare(`SELECT ${PROGRESSION_COLUMNS} FROM gtd_progressions WHERE gtd_id = ? ORDER BY created_at`)
      .bind(gtdId)
      .all<GtdProgressionRow>();
    return res.results;
  }

  /** Привязка выданного продолжения к решению: видно, какой Run выдал GTD. */
  async setProgressionRun(progressionId: string, continuationRunId: string | null): Promise<void> {
    await this.db
      .prepare(`UPDATE gtd_progressions SET continuation_run_id = ? WHERE progression_id = ?`)
      .bind(continuationRunId, progressionId)
      .run();
  }

  // --------------------------------------------------------------- условия

  async insertCondition(c: GtdConditionRow): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO gtd_conditions(${CONDITION_COLUMNS}) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(condition_ref) DO NOTHING`,
      )
      .bind(c.condition_ref, c.gtd_id, c.user_task_id, c.conclusion, c.report_ref, c.source, c.created_at)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async getCondition(conditionRef: string): Promise<GtdConditionRow | null> {
    return this.db
      .prepare(`SELECT ${CONDITION_COLUMNS} FROM gtd_conditions WHERE condition_ref = ?`)
      .bind(conditionRef)
      .first<GtdConditionRow>();
  }
}
