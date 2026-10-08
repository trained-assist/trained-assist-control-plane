/** Runner недоступен (сеть/таймаут/5xx): задача не теряется, повтор безопасен. */
export class RunnerUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

/** Отказ Runner: конфликт идемпотентности, невалидный запрос, чужой engine. */
export class RunnerConflictError extends Error {
  readonly apiCode?: string;
  readonly fieldPaths: string[];

  constructor(message: string, options: { apiCode?: string; fieldPaths?: string[] } = {}) {
    super(message);
    this.name = 'RunnerConflictError';
    this.apiCode = options.apiCode;
    this.fieldPaths = options.fieldPaths ?? [];
  }
}

export class RunnerArtifactManifestError extends Error {
  constructor() {
    super('runner artifact manifest has no valid reference');
    this.name = 'RunnerArtifactManifestError';
  }
}

/** Попытка неизвестна Runner'у. */
export class RunnerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerNotFoundError';
  }
}

/** Отмена/запись отвергнуты: устаревший ownerGeneration. */
export class RunnerStaleGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerStaleGenerationError';
  }
}
