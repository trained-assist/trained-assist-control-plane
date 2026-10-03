/**
 * Расписание в D1 (миграция 0006).
 *
 * Хранилище тонкое: только durable-факты и дедуп. Правила (overlap, misfire,
 * «disable не отменяет», «повтор не создаёт второе срабатывание») живут в
 * ScheduleService, а не в SQL — иначе политика расписания разъезжается между
 * хранилищем и логами.
 */
import type { OccurrenceRow, OccurrenceState, ScheduleRow } from './types';

const SCHEDULE_COLUMNS = `schedule_id, profile_id, cron_expr, timezone, goal, project_id, conversation_id,
    audience_id, destination_id, overlap_policy, catch_up_policy, max_admit_attempts,
    enabled, next_due_at, created_at, updated_at, revision`;

const OCCURRENCE_COLUMNS = `occurrence_id, schedule_id, profile_id, occurrence_key, scheduled_for,
    state, reason, user_task_id, run_id, gtd_id, attempts, created_at, updated_at`;

/** Терминальный статус задачи: occurrence считается завершённым (для overlap). */
const TERMINAL_SQL = `t.status NOT IN ('done','failed','cancelled')`;

export class ScheduleStore {
  constructor(private readonly db: D1Database) {}

  async insertSchedule(s: ScheduleRow): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO schedules(${SCHEDULE_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(schedule_id) DO NOTHING`,
      )
      .bind(
        s.schedule_id,
        s.profile_id,
        s.cron_expr,
        s.timezone,
        s.goal,
        s.project_id,
        s.conversation_id,
        s.audience_id,
        s.destination_id,
        s.overlap_policy,
        s.catch_up_policy,
        s.max_admit_attempts,
        s.enabled,
        s.next_due_at,
        s.created_at,
        s.updated_at,
        s.revision,
      )
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async getSchedule(scheduleId: string): Promise<ScheduleRow | null> {
    return this.db
      .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE schedule_id = ?`)
      .bind(scheduleId)
      .first<ScheduleRow>();
  }

  async listSchedules(profileId?: string): Promise<ScheduleRow[]> {
    const sql = profileId
      ? `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE profile_id = ? ORDER BY created_at`
      : `SELECT ${SCHEDULE_COLUMNS} FROM schedules ORDER BY created_at`;
    const stmt = profileId ? this.db.prepare(sql).bind(profileId) : this.db.prepare(sql);
    const res = await stmt.all<ScheduleRow>();
    return res.results;
  }

  /** Включённые расписания, у которых момент срабатывания наступил. */
  async dueSchedules(now: number, profileId?: string): Promise<ScheduleRow[]> {
    const sql = profileId
      ? `SELECT ${SCHEDULE_COLUMNS} FROM schedules
         WHERE enabled = 1 AND profile_id = ? AND next_due_at IS NOT NULL AND next_due_at <= ?
         ORDER BY next_due_at LIMIT 200`
      : `SELECT ${SCHEDULE_COLUMNS} FROM schedules
         WHERE enabled = 1 AND next_due_at IS NOT NULL AND next_due_at <= ?
         ORDER BY next_due_at LIMIT 200`;
    const stmt = profileId ? this.db.prepare(sql).bind(profileId, now) : this.db.prepare(sql).bind(now);
    const res = await stmt.all<ScheduleRow>();
    return res.results;
  }

  /**
   * Enable/Disable меняют ТОЛЬКО разрешение будущих срабатываний. next_due_at при
   * disable не обнуляется: после enable ближайшее будущее срабатывание считается
   * заново (следующее после «сейчас»), а уже принятые задачи живут своей жизнью.
   */
  async setEnabled(scheduleId: string, enabled: boolean, now: number): Promise<ScheduleRow | null> {
    await this.db
      .prepare(`UPDATE schedules SET enabled = ?, updated_at = ?, revision = revision + 1 WHERE schedule_id = ?`)
      .bind(enabled ? 1 : 0, now, scheduleId)
      .run();
    return this.getSchedule(scheduleId);
  }

  /** Сдвиг next_due_at после успешного/пропущенного срабатывания (одна запись). */
  async setNextDue(scheduleId: string, nextDueAt: number | null, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE schedules SET next_due_at = ?, updated_at = ?, revision = revision + 1 WHERE schedule_id = ?`)
      .bind(nextDueAt, now, scheduleId)
      .run();
  }

  async insertOccurrence(o: OccurrenceRow): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO schedule_occurrences(${OCCURRENCE_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(schedule_id, occurrence_key) DO NOTHING`,
      )
      .bind(
        o.occurrence_id,
        o.schedule_id,
        o.profile_id,
        o.occurrence_key,
        o.scheduled_for,
        o.state,
        o.reason,
        o.user_task_id,
        o.run_id,
        o.gtd_id,
        o.attempts,
        o.created_at,
        o.updated_at,
      )
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async getOccurrence(scheduleId: string, occurrenceKey: string): Promise<OccurrenceRow | null> {
    return this.db
      .prepare(`SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences WHERE schedule_id = ? AND occurrence_key = ?`)
      .bind(scheduleId, occurrenceKey)
      .first<OccurrenceRow>();
  }

  async getOccurrenceById(occurrenceId: string): Promise<OccurrenceRow | null> {
    return this.db
      .prepare(`SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences WHERE occurrence_id = ?`)
      .bind(occurrenceId)
      .first<OccurrenceRow>();
  }

  async listOccurrences(scheduleId: string, limit = 100): Promise<OccurrenceRow[]> {
    const res = await this.db
      .prepare(
        `SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences WHERE schedule_id = ? ORDER BY scheduled_for LIMIT ?`,
      )
      .bind(scheduleId, Math.min(Math.max(1, limit), 500))
      .all<OccurrenceRow>();
    return res.results;
  }

  /**
   * Occurrence, чей момент наступил, но задача не принята: `due` — краш до
   * приёма, `failed` — приём упал. Это и есть очередь восстановления: повтор
   * tick/sweep доставляет её с ТЕМИ ЖЕ ключами, поэтому второго срабатывания
   * не появляется.
   */
  async unadmittedOccurrences(limit = 50, profileId?: string): Promise<OccurrenceRow[]> {
    const sql = profileId
      ? `SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences
         WHERE state IN ('due','failed') AND profile_id = ? ORDER BY scheduled_for LIMIT ?`
      : `SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences
         WHERE state IN ('due','failed') ORDER BY scheduled_for LIMIT ?`;
    const stmt = profileId
      ? this.db.prepare(sql).bind(profileId, Math.min(Math.max(1, limit), 200))
      : this.db.prepare(sql).bind(Math.min(Math.max(1, limit), 200));
    const res = await stmt.all<OccurrenceRow>();
    return res.results;
  }

  async markOccurrence(
    occurrenceId: string,
    patch: { state: OccurrenceState; reason?: string | null; userTaskId?: string | null; runId?: string | null; bumpAttempts?: boolean },
    now: number,
  ): Promise<OccurrenceRow | null> {
    const current = await this.getOccurrenceById(occurrenceId);
    if (!current) return null;
    await this.db
      .prepare(
        `UPDATE schedule_occurrences
         SET state = ?, reason = ?, user_task_id = COALESCE(?, user_task_id), run_id = COALESCE(?, run_id),
             attempts = attempts + ?, updated_at = ?
         WHERE occurrence_id = ?`,
      )
      .bind(
        patch.state,
        patch.reason ?? null,
        patch.userTaskId ?? null,
        patch.runId ?? null,
        patch.bumpAttempts ? 1 : 0,
        now,
        occurrenceId,
      )
      .run();
    return this.getOccurrenceById(occurrenceId);
  }

  /**
   * Есть ли у расписания незавершённая задача (overlap_policy='skip'). Смотрим
   * ТОЛЬКО принятые occurrence: пропущенные и упавшие не держат расписание.
   */
  async hasUnfinishedOccurrence(scheduleId: string, exceptOccurrenceId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS busy FROM schedule_occurrences o
         JOIN durable_tasks t ON t.id = o.user_task_id
         WHERE o.schedule_id = ? AND o.state = 'admitted' AND o.occurrence_id <> ? AND ${TERMINAL_SQL}
         LIMIT 1`,
      )
      .bind(scheduleId, exceptOccurrenceId)
      .first<{ busy: number }>();
    return row !== null;
  }

  /**
   * Сколько occurrence этого расписания ещё в работе (приняты, задача не
   * терминальна). Disable это число логирует и НЕ использует для отмены:
   * выключение расписания не отменяет уже принятые задачи (AC-140).
   */
  async countUnfinishedOccurrences(scheduleId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM schedule_occurrences o
         JOIN durable_tasks t ON t.id = o.user_task_id
         WHERE o.schedule_id = ? AND o.state = 'admitted' AND ${TERMINAL_SQL}`,
      )
      .bind(scheduleId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }
}
