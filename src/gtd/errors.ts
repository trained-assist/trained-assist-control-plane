/**
 * Ошибки GTD (P23). Каждая — с причиной и HTTP-статусом: отказ контроля обязан
 * быть виден вызывающему, а не превращаться в тихий переход к output-owned
 * recovery (§5a: «Отсутствующий/неизвестный gtdId у managed outcome — contract
 * error: quarantine/reconciliation и явный статус»).
 */
export class GtdError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GtdError';
  }
}

/** Повторная регистрация контроля на ту же User Task (UNIQUE user_task_id). */
export class GtdAlreadyRegisteredError extends GtdError {
  constructor(userTaskId: string, reason: string) {
    super(`control record already exists for task ${userTaskId}: ${reason}`, 409, reason);
    this.name = 'GtdAlreadyRegisteredError';
  }
}

/** Самоконтроль: запись не может контролировать себя или другую запись. */
export class GtdSelfSupervisionError extends GtdError {
  constructor(reason = 'self_gtd_not_allowed') {
    super('GTD cannot supervise itself or another control record', 409, reason);
    this.name = 'GtdSelfSupervisionError';
  }
}

/** Неизвестный gtdId у managed outcome — contract error, не тихий fallback. */
export class GtdUnknownRecordError extends GtdError {
  constructor(gtdId: string) {
    super(`unknown control record: ${gtdId}`, 409, 'unknown_control_record');
    this.name = 'GtdUnknownRecordError';
  }
}

/** Исход принадлежит другой задаче, чем запись контроля. */
export class GtdOutcomeScopeError extends GtdError {
  constructor(gtdId: string, expected: string, actual: string) {
    super(`outcome for task ${actual} does not belong to control record ${gtdId} (task ${expected})`, 409, 'outcome_scope_mismatch');
    this.name = 'GtdOutcomeScopeError';
  }
}

/** Продолжение выдано, но живая попытка уже идёт — прерывать её нельзя. */
export class GtdActiveRunError extends GtdError {
  constructor(userTaskId: string) {
    super(`task ${userTaskId} has an active run; continuation deferred`, 409, 'active_run_in_progress');
    this.name = 'GtdActiveRunError';
  }
}
