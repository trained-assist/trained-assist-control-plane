/**
 * Конечный текст движка, извлечённый из потока событий Runner.
 *
 * Почему из событий, а не из результата: контракт Serverless Agent API
 * (`RunResult` в `ai-agent-runner/src/contracts/result.ts`) несёт только
 * outcome/exitReason/outputRefs — поля с текстом ответа в нём нет. Единственный
 * носитель текста движка — события `log` со `stream: 'stdout'` (`onEngineLog` в
 * `runner.ts`: каждая строка stdout дочернего процесса становится событием).
 *
 * Правила извлечения (версионированы, чтобы смена формата ответа движка была
 * явным переходом, а не тихим изменением результата):
 *  1. Берутся ТОЛЬКО события `log` / `stream: 'stdout'`. stderr и служебные
 *     события Runner'а в ответ не попадают.
 *  2. Строки склеиваются в порядке `sequence` через '\n' и обрезаются по краям.
 *  3. Пустой результат = `null`: «движок не ответил» не выдаётся за ответ.
 *
 * Это НЕ парсинг текста и не новый agent loop: контрольный слой  — приёмник
 * результата, движок остаётся владельцем диалога.
 */
import type { RunnerEvent } from './runner-api-adapter';

export const ENGINE_TEXT_VERSION = 'engine-text-v1';

export interface EngineText {
  /** Конечный текст ответа движка (stdout), без служебных строк Runner'а. */
  text: string;
  version: typeof ENGINE_TEXT_VERSION;
  /** Источник текста: поток событий Runner'а, а не поле результата. */
  source: 'runner_log_stdout';
  /** Сколько строк stdout вошло в ответ. */
  lines: number;
}

const STDOUT_STREAMS: ReadonlySet<string> = new Set(['stdout']);

export function extractEngineText(events: readonly RunnerEvent[]): EngineText | null {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const lines: string[] = [];
  for (const event of ordered) {
    if (event.type !== 'log') continue;
    const payload = event.payload as { stream?: unknown; message?: unknown } | undefined;
    if (!payload || !STDOUT_STREAMS.has(String(payload.stream ?? ''))) continue;
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message.length > 0) lines.push(message);
  }
  const text = lines.join('\n').trim();
  if (text.length === 0) return null;
  return { text, version: ENGINE_TEXT_VERSION, source: 'runner_log_stdout', lines: lines.length };
}
