/**
 * Признаки текста запроса — без решений (P16).
 *
 * Главное правило модуля: он ничего не решает. «Ссылка есть» — признак;
 * «нужен агент» — решение, и оно принимается в `policy.ts` только вместе с
 * намерением и каталогом. Именно это разделение ловит ловушку PR-23
 * (ссылка в цитате) и PR-24 (слова «rate limit» в обычном ответе).
 *
 * Цитаты вырезаются ДО анализа намерения: текст внутри «…»/«…»/„…“ — это данные
 * пользователя, а не команда системе. Инструкция внутри цитаты помечается, но
 * никогда не превращается в маршрут.
 */
import type { AttachmentFeature, TextFeatures, UrlFeature } from './router-types';

/** Нормализация для сравнения: регистр, «ё», пунктуация, пробелы. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const URL_RE = /https?:\/\/[^\s«»„“"'<>)\]]+/gi;

/** Цитаты: «…», "…", „…“ — вложенный текст пользователя. */
function quotedSpansOf(text: string): Array<{ start: number; end: number; content: string }> {
  const spans: Array<{ start: number; end: number; content: string }> = [];
  const patterns: Array<[RegExp, number]> = [
    [/[«"]/g, 1],
    [/„/g, 1],
  ];
  for (const [open, len] of patterns) {
    open.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = open.exec(text)) !== null) {
      const start = m.index;
      const closeRe = start >= 0 && text[start] === '«' ? /»/g : m[0] === '„' ? /[“”]/g : /"/g;
      closeRe.lastIndex = start + len;
      const close = closeRe.exec(text);
      if (!close) continue;
      spans.push({ start, end: close.index + close[0].length, content: text.slice(start + len, close.index) });
      open.lastIndex = close.index + close[0].length;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

const READ_VERBS = [
  'открой',
  'открыть',
  'открывай',
  'прочитай',
  'прочитать',
  'читай',
  'посмотри',
  'посмотреть',
  'зайди',
  'зайти',
  'перейди',
  'скачай страницу',
  'загрузи страницу',
];

const FRESHNESS_NOUNS = [
  'сейчас',
  'актуальн',
  'текущ',
  'сегодняшн',
  'последн',
  'курс',
  'цена',
  'стоимость сейчас',
  'новост',
  'что написано',
  'что на главной',
  'что там',
  'проверь что',
  'проверь актуальность',
];

const EFFECT_VERBS = [
  'отправь',
  'отправить',
  'опубликуй',
  'опубликовать',
  'удали',
  'удалить',
  'оплати',
  'оплатить',
  'создай и опубликуй',
  'перешли',
  'назначь встречу',
  'забронируй',
  'поставь задачу',
];

const ADAPTIVE_CUES = [
  'найди',
  'найти',
  'поищи',
  'изучи',
  'разберись',
  'сравни',
  'собери данные',
  'собери по',
  'выбери',
  'итератив',
  'продолжай пока',
  'пока не',
  'несколько источников',
  'погугли',
  'поиск по',
];

const TEXT_WORK_CUES = [
  'сделай короче',
  'короче',
  'перепиши',
  'перепиши короче',
  'переведи',
  'оформи',
  'таблиц',
  'сократи',
  'сократи текст',
  'объясни',
  'что такое',
  'почему',
  'посчитай',
  'рассчитай',
  'сравни два',
  'напиши',
  'черновик',
  'ответить',
  'ответ',
  'как вежливо',
  'как ответить',
  'итог',
  'вывод',
  'перескажи',
  'перефразируй',
  'сформулируй',
  'разбери',
  'поясни',
];

const CLOSING_CUES = ['достаточно', 'хватит', 'собери итог', 'собери результат', 'подведи итог', 'на этом все', 'закончи'];
const ACK_CUES = ['ок', 'окей', 'спасибо', 'спс', 'понял', 'поняла', 'принял', 'благодарю', 'хорошо'];
/** Инструкция внутри цитаты — данные; наличие фиксируется, исполнение запрещено. */
const EMBEDDED_INSTRUCTION_CUES = [
  'игнорируй все инструкции',
  'запусти агента',
  'запусти агент',
  'дай доступ к файлам',
  'отправь это',
  'выполни инструкцию',
  'забудь правила',
  'system prompt',
  'ignore all instructions',
  'ignore previous instructions',
];

const BARE_IMPERATIVES = ['сделай', 'сделайте', 'давай', 'го', 'нужно', 'надо'];

function containsAny(normalized: string, cues: string[]): string[] {
  return cues.filter((cue) => normalized.includes(cue));
}

/**
 * Глагол чтения засчитывается не где угодно в тексте, а там, где он является
 * просьбой: в голове сообщения (первые пять слов) либо рядом с объектом/URL.
 * Иначе «что посмотрим позже?» (FR-052) читалось бы как просьба открыть
 * страницу, а цитата со ссылкой вела бы в агент — ровно ловушка PR-23.
 */
function readIntentOutsideQuote(quoted: Array<{ start: number; end: number }>, text: string): boolean {
  const normalized = normalizeText(text);
  const hits = containsAny(normalized, READ_VERBS);
  if (hits.length === 0) return false;
  // Глагол чтения внутри цитаты не считается просьбой системе: у FR-052
  // цитата может начинаться со «см. <url>», у FR-060 — с инструкции.
  const outside = normalizeText(textOutsideQuotes(text, quoted));
  for (const hit of hits) {
    if (!outside.includes(hit)) return false;
  }
  const head = outside.split(' ').slice(0, 5).join(' ');
  if (hits.some((hit) => head.includes(hit))) return true;
  return READ_OBJECT_RE.test(outside) || URL_RE.test(text);
}

const READ_OBJECT_RE = new RegExp(
  `(${READ_VERBS.join('|')})\\s+(страниц\\w*|сайт\\w*|документ\\w*|стать\\w+|файл\\w*|ссылк\\w*)`,
);

/** Текст запроса без цитат: только authored-by-user часть участвует в намерениях. */
export function textOutsideQuotes(text: string, quoted: Array<{ start: number; end: number }>): string {
  if (quoted.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of quoted) {
    out += text.slice(cursor, span.start) + ' ';
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

function urlFeatures(text: string, quoted: Array<{ start: number; end: number }>, readIntent: boolean): UrlFeature[] {
  const features: UrlFeature[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const raw = m[0];
    const inQuote = quoted.some((span) => m!.index >= span.start && m!.index < span.end);
    let host = raw;
    try {
      host = new URL(raw).host;
    } catch {
      host = raw.slice(0, 60);
    }
    features.push({ host, quoted: inQuote, readIntentOutsideQuote: readIntent && !inQuote });
  }
  return features;
}

/**
 * Признаки запроса. Вход — полный текст (не обрезанный), чтобы ссылки и
 * инструкции в середине не терялись (§11.6).
 */
export function extractTextFeatures(text: string): TextFeatures {
  const quoted = quotedSpansOf(text);
  const outside = normalizeText(textOutsideQuotes(text, quoted));
  const normalized = normalizeText(text);

  const readIntent = readIntentOutsideQuote(quoted, text);
  const urls = urlFeatures(text, quoted, readIntent);
  const quotedText = normalizeText(quoted.map((s) => s.content).join(' '));

  const freshness = containsAny(outside, FRESHNESS_NOUNS);
  const effect = containsAny(outside, EFFECT_VERBS);
  const adaptive = containsAny(outside, ADAPTIVE_CUES);
  const textWork = containsAny(outside, TEXT_WORK_CUES);
  const closing = containsAny(outside, CLOSING_CUES);
  const ack = containsAny(normalized, ACK_CUES);

  return {
    normalized,
    urls,
    quotedSpans: quoted.length,
    embeddedInstruction: containsAny(quotedText, EMBEDDED_INSTRUCTION_CUES).length > 0,
    readIntent,
    freshnessIntent: freshness.length > 0,
    effectIntent: effect.length > 0,
    adaptiveIntent: adaptive.length > 0,
    textWorkIntent: textWork.length > 0,
    closingIntent: closing.length > 0,
    acknowledgementIntent: ack.length > 0 && outside.length <= 40,
    bareImperative: BARE_IMPERATIVES.some((cue) => outside === cue || outside === `${cue} `),
  };
}

/**
 * Покрывает ли совпавший алиас весь запрос. Детерминированный путь берётся, только
 * если он объясняет ВСЮ просьбу: «открой сайт и прочитай мою таблицу» не должно
 * молча обслуживаться чтением таблицы (пропуск действия — это false-fast, §11.2).
 */
export function aliasCoversRequest(normalized: string, aliases: string[]): boolean {
  const needles = aliases.map((alias) => alias.trim().toLowerCase()).filter((alias) => alias.length > 0);
  const clauses = normalized
    .split(/[,;.!?]+|\sи\s/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => needles.some((needle) => clause.includes(needle)) || CLAUSE_FILLERS.has(clause));
}

const CLAUSE_FILLERS = new Set([
  'пожалуйста',
  'спасибо',
  'и',
  'а',
  'ну',
  'да',
  'ок',
  'потом',
  'еще',
  'мне',
  'у меня',
]);

/** Покрытие входа: извлечение вложения не закончено — отвечать по нему нельзя. */
export function coverageOf(attachments: AttachmentFeature[], prepared: { readinessSnapshotPresent: boolean }): {
  coverage: 'full' | 'attachment_pending' | 'missing_snapshot' | 'stale';
  pendingArtifacts: string[];
} {
  if (!prepared.readinessSnapshotPresent) return { coverage: 'missing_snapshot', pendingArtifacts: [] };
  const pending = attachments.filter((a) => !a.extracted).map((a) => a.artifactRef);
  if (pending.length > 0) return { coverage: 'attachment_pending', pendingArtifacts: pending };
  return { coverage: 'full', pendingArtifacts: [] };
}
