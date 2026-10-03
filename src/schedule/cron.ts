/**
 * Cron + timezone без внешних библиотек (P22, этап I07).
 *
 * Расписание хранит cron-выражение и IANA-временную зону; срабатывания считаются
 * в ЗОНЕ расписания, а не в зоне рантайма: «каждый час» в Europe/Moscow и
 * America/New_York — разные моменты, и переход на летнее время меняет их.
 *
 * Границы (осознанные, не «всё умеем»):
 *  - 5 полей: minute hour day-of-month month day-of-week (как у планировщиков
 *    Cloudflare/Vixie). Имена месяцев/дней не принимаются — числовая форма не
 *    разъезжается между рантаймами;
 *  - если ограничены И день месяца, И день недели — совпадение по ЛЮБОМУ из них
 *    (поведение Vixie cron);
 *  - несуществующее локальное время (пропуск часа при переходе на летнее время)
 *    срабатыванием НЕ считается: кандидат отбрасывается, берётся следующий;
 *  - горизонт поиска ограничен (nextCronDate вернёт null, а не зациклится).
 */

/** Разобранное cron-выражение: множества допустимых значений по полям. */
export interface CronExpr {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** Поле дня месяца было ограничено (важно для правила ИЛИ с днём недели). */
  domRestricted: boolean;
  /** Поле дня недели было ограничено. */
  dowRestricted: boolean;
  /** Исходное выражение — для логов и сообщений об ошибках. */
  source: string;
}

export class InvalidScheduleError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'InvalidScheduleError';
  }
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

const parseField = (
  raw: string,
  spec: { name: string; min: number; max: number },
  dayOfWeek: boolean,
): { values: number[]; restricted: boolean } => {
  const text = raw.trim();
  if (!text) throw new InvalidScheduleError(`${spec.name} must not be empty`, 'cron');
  const restricted = text !== '*' && !/^\*\/(\d+)$/.test(text);
  const values = new Set<number>();

  for (const part of text.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new InvalidScheduleError(`${spec.name}: invalid step in "${part}"`, 'cron');
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step < 1) throw new InvalidScheduleError(`${spec.name}: step must be >= 1`, 'cron');

    let from: number;
    let to: number;
    const range = (rangePart ?? '').trim();
    if (range === '*') {
      from = spec.min;
      to = spec.max;
    } else if (/^\d+$/.test(range)) {
      from = Number(range);
      to = stepPart === undefined ? from : spec.max;
    } else if (/^\d+-\d+$/.test(range)) {
      const [a, b] = range.split('-').map(Number);
      from = a!;
      to = b!;
    } else {
      throw new InvalidScheduleError(`${spec.name}: invalid value "${part}"`, 'cron');
    }
    if (from < spec.min || to > spec.max || from > to) {
      throw new InvalidScheduleError(`${spec.name}: value out of range "${part}"`, 'cron');
    }
    for (let v = from; v <= to; v += step) {
      // 7 = воскресенье, как в cron; приводим к 0.
      values.add(dayOfWeek && v === 7 ? 0 : v);
    }
  }

  return { values: [...values].sort((a, b) => a - b), restricted };
};

export function parseCron(expression: string): CronExpr {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new InvalidScheduleError('cron expression must be a non-empty string', 'cron');
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new InvalidScheduleError(`cron must have 5 fields, got ${parts.length}`, 'cron');
  }
  const minute = parseField(parts[0]!, FIELDS[0], false);
  const hour = parseField(parts[1]!, FIELDS[1], false);
  const dom = parseField(parts[2]!, FIELDS[2], false);
  const month = parseField(parts[3]!, FIELDS[3], false);
  const dow = parseField(parts[4]!, FIELDS[4], true);

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
    source: expression.trim(),
  };
}

/** Проверка имени зоны: Intl отвергает мусор, а не молча трактует его как UTC. */
export function assertTimezone(timezone: string): string {
  if (typeof timezone !== 'string' || !timezone.trim()) {
    throw new InvalidScheduleError('timezone must be a non-empty IANA name', 'timezone');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new InvalidScheduleError(`unknown timezone: ${timezone}`, 'timezone');
  }
  return timezone.trim();
}

interface WallClock {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, fmt);
  }
  return fmt;
};

/** Локальное время зоны в момент ms (epoch). */
export function zonedWallClock(timezone: string, ms: number): WallClock {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

/** Смещение зоны в ms в момент ms: wallClock, прочитанное как будто это UTC. */
function zoneOffsetMs(timezone: string, ms: number): number {
  const w = zonedWallClock(timezone, ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0) - Math.floor(ms / 60000) * 60000;
}

/**
 * Момент ms для локального времени зоны. null = такого локального времени не
 * существует (час пропущен при переходе на летнее время).
 */
export function wallClockToInstant(timezone: string, wall: WallClock): number | null {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  // Две итерации достаточно: первая даёт смещение, вторая — смещение в найденной
  // точке (итерация нужна ровно на границе перехода).
  let instant = naive - zoneOffsetMs(timezone, naive);
  instant = naive - zoneOffsetMs(timezone, instant);
  const back = zonedWallClock(timezone, instant);
  const same =
    back.year === wall.year &&
    back.month === wall.month &&
    back.day === wall.day &&
    back.hour === wall.hour &&
    back.minute === wall.minute;
  return same ? instant : null;
}

const nextDay = (year: number, month: number, day: number): WallClock => {
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0 };
};

const dayMatches = (expr: CronExpr, year: number, month: number, day: number, weekday: number): boolean => {
  if (!expr.months.includes(month)) return false;
  const domHit = expr.daysOfMonth.includes(day);
  const dowHit = expr.daysOfWeek.includes(weekday);
  if (expr.domRestricted && expr.dowRestricted) return domHit || dowHit;
  if (expr.domRestricted) return domHit;
  if (expr.dowRestricted) return dowHit;
  return true;
};

/**
 * Следующее срабатывание строго ПОСЛЕ afterMs (ms epoch) в зоне timezone.
 * null = срабатывания в горизонте нет (или выражение невозможно).
 */
export function nextCronDate(expression: CronExpr, timezone: string, afterMs: number, horizonDays = 400): number | null {
  assertTimezone(timezone);
  const wallStart = zonedWallClock(timezone, afterMs);
  let { year, month, day } = wallStart;
  let fromHour = wallStart.hour;
  let fromMinute = wallStart.minute;

  for (let dayIndex = 0; dayIndex <= horizonDays; dayIndex++) {
    if (dayIndex > 0) {
      ({ year, month, day } = nextDay(year, month, day));
      fromHour = 0;
      fromMinute = 0;
    }
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (!dayMatches(expression, year, month, day, weekday)) continue;

    for (const hour of expression.hours) {
      for (const minute of expression.minutes) {
        if (hour < fromHour || (hour === fromHour && minute <= fromMinute)) continue;
        const instant = wallClockToInstant(timezone, { year, month, day, hour, minute });
        // Несуществующее локальное время (DST gap) — не срабатывание.
        if (instant === null || instant <= afterMs) continue;
        return instant;
      }
    }
  }
  return null;
}

/** Все просроченные срабатывания до now, начиная с dueMs (включая dueMs). */
export function dueCronDates(
  expression: CronExpr,
  timezone: string,
  dueMs: number,
  nowMs: number,
  limit = 500,
): number[] {
  const due: number[] = [];
  let cursor: number | null = dueMs;
  while (cursor !== null && cursor <= nowMs && due.length < limit) {
    due.push(cursor);
    cursor = nextCronDate(expression, timezone, cursor);
  }
  return due;
}
