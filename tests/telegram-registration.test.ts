import { describe, expect, it } from 'vitest';
import { env } from './env';
import { TelegramRegistrationService, STARTER_GRANT } from '../src/registration/telegram-registration';

const service = new TelegramRegistrationService(env.DB);
let updateId = 900_000;
const send = (user: string, text: string, extra: Record<string, unknown> = {}) => service.handle({
  botIdentity: 'sandbox3-test', telegramUserId: user, chatId: user, chatType: 'private', updateId: updateId++, text, ...extra,
});

describe('Telegram self-registration and starter grant', () => {
  it('requires exactly two profile questions, defaults optional name to private chat id, and grants exactly once', async () => {
    const user = `9${Date.now()}1`;
    try {
    expect((await send(user, '/start')).step).toBe('activity');
    expect((await send(user, 'I build small web applications for independent shops and help with analytics.')).step).toBe('social_url');
    expect((await send(user, 'https://example.org/profile')).step).toBe('profile_name');
    const complete = await send(user, '/skip');
    expect(complete.step).toBe('complete');
    expect(complete.displayName).toBe(user);
    expect(complete.grant).toBe(STARTER_GRANT);
    expect((await send(user, '/start')).grant).toBe(STARTER_GRANT);
    const account = await env.DB.prepare(`SELECT a.account_id,p.display_name,p.social_url,p.activity_text,b.grant_amount,
      (SELECT count(*) FROM account_budget_ledger l WHERE l.account_id=a.account_id AND l.kind='grant') grant_count
      FROM telegram_accounts a JOIN telegram_profiles p USING(profile_id) JOIN account_budget_state b USING(account_id)
      WHERE a.telegram_user_id=? AND a.bot_identity='sandbox3-test'`).bind(user).first<Record<string, unknown>>();
    expect(account?.display_name).toBe(user);
    expect(account?.social_url).toBe('https://example.org/profile');
    expect(account?.grant_amount).toBe(STARTER_GRANT);
    expect(account?.grant_count).toBe(1);
    await env.DB.prepare(`DELETE FROM telegram_update_receipts WHERE telegram_user_id=?`).bind(user).run();
    const acct = String(account?.account_id);
    await env.DB.prepare(`DELETE FROM account_budget_ledger WHERE account_id=?`).bind(acct).run();
    await env.DB.prepare(`DELETE FROM account_budget_state WHERE account_id=?`).bind(acct).run();
    await env.DB.prepare(`DELETE FROM telegram_profiles WHERE profile_id=(SELECT profile_id FROM telegram_accounts WHERE account_id=?)`).bind(acct).run();
    await env.DB.prepare(`DELETE FROM telegram_accounts WHERE account_id=?`).bind(acct).run();
    await env.DB.prepare(`DELETE FROM telegram_onboarding_sessions WHERE telegram_user_id=? AND bot_identity='sandbox3-test'`).bind(user).run();
    } finally {
      const account = await env.DB.prepare(`SELECT account_id FROM telegram_accounts WHERE telegram_user_id=? AND bot_identity='sandbox3-test'`).bind(user).first<{account_id:string}>();
      if (account) {
        await env.DB.prepare(`DELETE FROM account_budget_ledger WHERE account_id=?`).bind(account.account_id).run();
        await env.DB.prepare(`DELETE FROM account_budget_state WHERE account_id=?`).bind(account.account_id).run();
        await env.DB.prepare(`DELETE FROM telegram_profiles WHERE account_id=?`).bind(account.account_id).run();
        await env.DB.prepare(`DELETE FROM telegram_accounts WHERE account_id=?`).bind(account.account_id).run();
      }
      await env.DB.prepare(`DELETE FROM telegram_update_receipts WHERE telegram_user_id=?`).bind(user).run();
      await env.DB.prepare(`DELETE FROM telegram_onboarding_sessions WHERE telegram_user_id=? AND bot_identity='sandbox3-test'`).bind(user).run();
    }
  });

  it('replays an update idempotently and refuses group or mismatched identity', async () => {
    const user = `9${Date.now()}2`;
    try {
    const update = { botIdentity: 'sandbox3-test', telegramUserId: user, chatId: user, chatType: 'private', updateId: updateId++, text: '/start' } as const;
    const first = await service.handle(update);
    const replay = await service.handle(update);
    expect(first.step).toBe('activity');
    expect(replay.duplicate).toBe(true);
    await expect(service.handle({ ...update, updateId: updateId++, chatType: 'group' })).rejects.toThrow('private_telegram_identity_required');
    await expect(service.handle({ ...update, updateId: updateId++, chatId: '123' })).rejects.toThrow('private_telegram_identity_required');
    await env.DB.prepare(`DELETE FROM telegram_update_receipts WHERE telegram_user_id=?`).bind(user).run();
    await env.DB.prepare(`DELETE FROM telegram_onboarding_sessions WHERE telegram_user_id=? AND bot_identity='sandbox3-test'`).bind(user).run();
    } finally {
      await env.DB.prepare(`DELETE FROM telegram_update_receipts WHERE telegram_user_id=?`).bind(user).run();
      await env.DB.prepare(`DELETE FROM telegram_onboarding_sessions WHERE telegram_user_id=? AND bot_identity='sandbox3-test'`).bind(user).run();
    }
  });
});
