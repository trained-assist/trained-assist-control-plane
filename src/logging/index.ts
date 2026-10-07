import { activeErrorPublisher } from './error-publisher';
import { logStructured, type StructuredLogFields } from './structured-log';

export { logStructured, type StructuredLogFields } from './structured-log';
export {
  activeErrorPublisher,
  createErrorPublisher,
  getDroppedCount,
  getSpool,
  resolveErrorPublisher,
  setErrorPublisher,
  type C12ErrorEvent,
  type ErrorPublisherEnv,
  type ErrorPublisherOptions,
  type PublishErrorFn,
} from './error-publisher';

/**
 * Error-событие: логирует и публикует в Error Watcher через активный publisher
 * (level по умолчанию 'error'). Без настроенного publisher — только лог.
 */
export function logError(fields: StructuredLogFields): void {
  logStructured({ ...fields, level: fields.level ?? 'error' }, activeErrorPublisher());
}
