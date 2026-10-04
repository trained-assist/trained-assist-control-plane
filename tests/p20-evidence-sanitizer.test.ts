/**
 * Негативные проверки санитизации evidence P20. Отдельный тест (а не только
 * node-скрипт): проверять надо именно «санитизатор отказывается собирать
 * плохие данные», и это обязано проходить в CI.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeP20Evidence } from '../tools/p20-evidence.mjs';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CLEAN_EVENT = JSON.stringify({
  event: 'routing.brief',
  profileId: 'profile-cp20',
  userTaskId: 'ut-clean',
  runId: null,
  briefId: 'brief-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  briefKey: 'brief-a7746e38d861b34867cd0d5a',
  cacheHit: false,
  cacheStored: true,
  purpose: 'reply-or-route',
  catalogVersion: 'capabilities-v1',
  tier1Entries: 13,
  candidates: 11,
  tier2Entries: 11,
  bytes: 14316,
  budgetMaxBytes: 24576,
  budgetWithin: true,
});

/** Санитизатор обязан отказаться: возвращаем находки, а не транскрипт. */
function findingsOf(lines: string[], secret: string) {
  try {
    sanitizeP20Evidence({ lines, secret });
  } catch (error) {
    return (error as { findings?: string[] }).findings ?? [];
  }
  return [];
}

describe('P20 · санитизация evidence', () => {
  it('чистые логи собираются и дают воспроизводимый digest', () => {
    const first = sanitizeP20Evidence({ lines: [CLEAN_EVENT], secret: SECRET });
    const second = sanitizeP20Evidence({ lines: [CLEAN_EVENT], secret: SECRET });
    expect(first.digest).toBe(second.digest);
    expect(first.events).toHaveLength(1);
    expect(first.transcript).toContain('P20');
  });

  it('значение секрета останавливает сборку', () => {
    const findings = findingsOf([CLEAN_EVENT, `{"event":"route.dispatched","note":"secret=${SECRET}"}`], SECRET);
    expect(findings.some((f: string) => f.includes('PRINCIPAL_SECRET'))).toBe(true);
  });

  it('личный e-mail, домашний путь и телефон останавливают сборку', () => {
    const findings = findingsOf(
      [CLEAN_EVENT, '{"event":"route.dispatched","mail":"someone@personal-mail.example","file":"/Users/someone/private/notes.md","contact":"+7 999 123 45 67"}'],
      SECRET,
    );
    expect(findings.some((f: string) => f.includes('e-mail'))).toBe(true);
    expect(findings.some((f: string) => f.includes('домашний путь'))).toBe(true);
    expect(findings.some((f: string) => f.includes('телефон'))).toBe(true);
  });

  it('служебный шум dev-сервера в evidence не попадает', () => {
    const result = sanitizeP20Evidence({
      lines: ['GET / 200', CLEAN_EVENT, JSON.stringify({ event: 'intake.accepted', profileId: 'profile-cp20', userTaskId: 'ut-1' })],
      secret: SECRET,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events.some((line: string) => line.includes('intake.accepted'))).toBe(true);
    expect(result.events.some((line: string) => line.includes('routing.brief'))).toBe(true);
  });

  it('домены RFC 2606, идентификаторы и epoch-миллисекунды — не нарушение', () => {
    const result = sanitizeP20Evidence({
      lines: [CLEAN_EVENT, '{"event":"route.dispatched","url":"https://example.com/x","clock":1793388600000,"requestId":"req-1"}'],
      secret: SECRET,
    });
    expect(result.events).toHaveLength(2);
  });
});
