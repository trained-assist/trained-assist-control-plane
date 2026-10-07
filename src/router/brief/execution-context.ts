/**
 * Компактный контекст запуска из проверенного результата Router (arch#146 R4).
 *
 * Это task-level launch input для текущего Serverless Agent API, не trusted
 * system prompt и не grant инструментов. Исходный запрос остаётся отдельным,
 * неизменённым input.inlinePrompt. Capability metadata помогает исполнителю
 * понять замысел первого Router-вызова, но не доказывает, что tool смонтирован.
 */
import type { CatalogBrief } from './brief-types';

export const EXECUTION_CONTEXT_VERSION = 'execution-context-v1';
// Runner's submit contract caps `instructions` at 10,000 UTF-16 chars; keeping
// the UTF-8 budget below that also leaves room for code points/surrogates.
export const DEFAULT_EXECUTION_CONTEXT_MAX_BYTES = 9_000;
const MAX_SELECTED_CAPABILITIES = 10;
const MAX_CONSTRAINTS = 8;

export interface ExecutionContextManifest {
  version: typeof EXECUTION_CONTEXT_VERSION;
  decisionId: string;
  sourceBriefId: string;
  catalogVersion: string;
  catalogDigest: string;
  bytes: number;
  budgetMaxBytes: number;
  includedCapabilityIds: string[];
  unavailableCapabilityIds: string[];
  omittedCapabilityIds: string[];
  detailLevel: 'full' | 'compact' | 'goals_only';
}

export interface ExecutionContextInput {
  decisionId: string;
  suggestedGoal: string;
  originalRequestRef: string;
  reasonCode: string;
  hostConstraints: string[];
  modelPreservedConstraints: string[];
  selectedCapabilityIds: string[];
  requiresConfirmation: boolean;
  catalogBrief: CatalogBrief;
  maxBytes?: number;
}

export interface ExecutionContext {
  instructions: string;
  manifest: ExecutionContextManifest;
}

export class ExecutionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionContextError';
  }
}

const cleanLine = (value: string, maxChars: number): string =>
  value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);

const hostConstraintText: Record<string, string> = {
  no_publish: 'Не публиковать и не выкладывать результат наружу. Если публикация нужна для выполнения цели — остановиться и запросить ввод пользователя.',
  no_send: 'Не отправлять и не пересылать сообщения наружу. Перед отправкой остановиться и запросить ввод пользователя.',
  no_payment: 'Не выполнять и не подтверждать оплату или списание средств.',
  text_only: 'Вернуть результат текстом; не создавать и не публиковать внешний артефакт.',
};

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Сборка детерминирована и ограничена. При нехватке бюджета убираются только
 * пояснения каталога; цель и ограничения никогда не режутся молча.
 */
export function buildExecutionContext(input: ExecutionContextInput): ExecutionContext {
  const maxBytes = Math.max(1, input.maxBytes ?? DEFAULT_EXECUTION_CONTEXT_MAX_BYTES);
  const goal = cleanLine(input.suggestedGoal, 2_000);
  if (!goal) throw new ExecutionContextError('execution context requires a non-empty Router goal');

  const selectedIds = [...new Set(input.selectedCapabilityIds)];
  if (selectedIds.length > MAX_SELECTED_CAPABILITIES) {
    throw new ExecutionContextError(`execution context exceeds ${MAX_SELECTED_CAPABILITIES} selected capabilities`);
  }
  const entries = selectedIds.map((id) => {
    const entry = input.catalogBrief.tier1.find((candidate) => candidate.id === id);
    if (!entry) throw new ExecutionContextError(`selected capability is absent from the authorized catalog brief: ${id}`);
    return entry;
  });

  const hostIds = [...new Set(input.hostConstraints)].slice(0, MAX_CONSTRAINTS);
  const modelConstraints = [...new Set(input.modelPreservedConstraints.map((item) => cleanLine(item, 240)).filter(Boolean))]
    .slice(0, MAX_CONSTRAINTS);
  const hostRules = hostIds.map((id) => hostConstraintText[id] ?? `Сохранить ограничение хоста: ${cleanLine(id, 120)}`);
  const reason = cleanLine(input.reasonCode, 100);
  const requestRef = cleanLine(input.originalRequestRef, 300);
  const confirmation = input.requiresConfirmation
    ? 'В исходной задаче обнаружено внешнее действие: до такого действия получить явное подтверждение пользователя.'
    : 'Это поле не является разрешением на внешнее действие; соблюдай фактические права и подтверждения хоста.';

  const makeText = (detailLevel: ExecutionContextManifest['detailLevel']) => {
    const includedEntries = detailLevel === 'goals_only' ? [] : entries;
    const lines = [
      '## Краткий контекст запуска (host-built, execution-context-v1)',
      'Исходный запрос пользователя передан отдельно и остаётся главным источником цели и ограничений. Этот контекст дополняет его, но не заменяет и не расширяет права.',
      `Ссылка на исходный запрос: ${requestRef}`,
      `Цель, предложенная первым Router-вызовом: ${goal}`,
      `Причина передачи исполнителю: ${reason || 'не указана'}.`,
      'Ограничения хоста:',
      ...(hostRules.length ? hostRules.map((rule) => `- ${rule}`) : ['- Дополнительные явные ограничения хоста не извлечены. Исходный запрос всё равно обязателен к соблюдению.']),
      ...(modelConstraints.length ? ['Ограничения, сохранённые Router из запроса (сверяй с исходным текстом):', ...modelConstraints.map((item) => `- ${item}`)] : []),
      confirmation,
      'Подсказки capability из того же проверенного снимка каталога:',
      ...(includedEntries.length
        ? includedEntries.map((entry) => {
            const name = cleanLine(entry.summaryTitle || entry.routingName, 120);
            const readiness = entry.executable && entry.availability === 'enabled' ? 'eligible_at_catalog_snapshot' : `not_callable:${entry.availability}`;
            const description = detailLevel === 'full' ? ` — ${cleanLine(entry.summary, 220)}` : '';
            return `- ${entry.id}@${entry.version} (${name}; ${readiness}; modes=${entry.modes.join(',')})${description}`;
          })
        : [detailLevel === 'goals_only' && entries.length
            ? `- Capability hints omitted to stay within the ${maxBytes}-byte host budget: ${selectedIds.join(', ')}.`
            : '- Первый Router-вызов не выбрал конкретные capability ID. Не выдумывай capability по тексту этого brief.']),
      'Каталоговые подсказки не являются grant или доказательством, что инструмент смонтирован в этом Runner. Используй только инструменты, реально доступные в текущем запуске; если нужного нет, сообщи о пробеле и не имитируй вызов.',
    ];
    // Runner's `instructions` validator rejects control characters, including
    // newlines. Keep a single readable line with explicit separators.
    return lines.join(' | ');
  };

  let detailLevel: ExecutionContextManifest['detailLevel'] = 'full';
  let instructions = makeText(detailLevel);
  if (bytesOf(instructions) > maxBytes) {
    detailLevel = 'compact';
    instructions = makeText(detailLevel);
  }
  if (bytesOf(instructions) > maxBytes) {
    detailLevel = 'goals_only';
    instructions = makeText(detailLevel);
  }
  if (bytesOf(instructions) > maxBytes) {
    throw new ExecutionContextError(`execution context exceeds ${maxBytes} UTF-8 bytes`);
  }

  const includedCapabilityIds = detailLevel === 'goals_only' ? [] : entries.map((entry) => entry.id);
  return {
    instructions,
    manifest: {
      version: EXECUTION_CONTEXT_VERSION,
      decisionId: input.decisionId,
      sourceBriefId: input.catalogBrief.briefId,
      catalogVersion: input.catalogBrief.catalogVersion,
      catalogDigest: input.catalogBrief.catalogDigest,
      bytes: bytesOf(instructions),
      budgetMaxBytes: maxBytes,
      includedCapabilityIds,
      unavailableCapabilityIds: detailLevel === 'goals_only' ? [] : entries.filter((entry) => !entry.executable || entry.availability !== 'enabled').map((entry) => entry.id),
      omittedCapabilityIds: detailLevel === 'goals_only' ? entries.map((entry) => entry.id) : [],
      detailLevel,
    },
  };
}
