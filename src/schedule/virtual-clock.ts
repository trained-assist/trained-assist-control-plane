/**
 * Часы расписания (P22, этап I07).
 *
 * Время срабатывания — ВХОД модуля, а не глобальный Date.now(): песочница I07
 * требует hour/day waits без реального сна, поэтому тесты и evidence гоняют
 * расписание на виртуальных часах. В рантайме используется systemClock, и он
 * единственный источник «сейчас» по умолчанию.
 *
 * Виртуальные часы — тоже данные, а не подмена глобального состояния: их
 * передают в ScheduleService явно, поэтому тест никогда не влияет на соседние
 * файлы прогонов (общий рантайм miniflare в vitest).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class VirtualClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  /** Перевести часы (в прошлое тоже можно — тест откатывает время). */
  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}
