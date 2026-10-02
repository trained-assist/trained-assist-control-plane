/** Базовая ошибка репозитория Task Store. */
export class TaskStoreError extends Error {
  constructor(
    message: string,
    public readonly taskId?: string,
  ) {
    super(message);
    this.name = 'TaskStoreError';
  }
}

export class TaskNotFoundError extends TaskStoreError {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`, taskId);
    this.name = 'TaskNotFoundError';
  }
}

/**
 * Запись отвергнута generation fencing (INV-02): писатель держит устаревшее
 * ownerGeneration, состояние задачи не изменилось.
 */
export class FencedError extends TaskStoreError {
  constructor(
    taskId: string,
    public readonly attemptedGeneration: number,
    public readonly currentGeneration: number | null,
  ) {
    super(
      `fenced: task ${taskId} write with generation ${attemptedGeneration} != current ${currentGeneration}`,
      taskId,
    );
    this.name = 'FencedError';
  }
}

/**
 * Попытка изменить терминальную задачу (done/failed/cancelled) — guard
 * терминальных состояний, закрывает суть issue #90.
 */
export class TerminalStateError extends TaskStoreError {
  constructor(
    taskId: string,
    public readonly currentStatus: string,
    public readonly attemptedStatus?: string,
  ) {
    super(
      `terminal state: task ${taskId} is ${currentStatus}, refusing transition to ${attemptedStatus ?? '(no status)'}`,
      taskId,
    );
    this.name = 'TerminalStateError';
  }
}

/** У задачи уже есть открытое ожидание (частично-уникальный idx_awaiting_one_open). */
export class AlreadyOpenAwaitingError extends TaskStoreError {
  constructor(
    taskId: string,
    public readonly awaitingInputId: string,
  ) {
    super(`awaiting input already open for task ${taskId}: ${awaitingInputId}`, taskId);
    this.name = 'AlreadyOpenAwaitingError';
  }
}
