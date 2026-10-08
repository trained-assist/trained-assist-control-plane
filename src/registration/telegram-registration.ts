import type { D1Database } from '@cloudflare/workers-types';

export const STARTER_GRANT = 100_000_000;
export const STARTER_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const CONSENT_VERSION = 'telegram-registration-v1';

export interface TelegramRegistrationInput {
  botIdentity: string;
  telegramUserId: string;
  chatId: string;
  chatType: string;
  updateId: number;
  text: string;
  profileNameSkipped?: boolean;
  profileName?: string;
  now?: number;
}

export interface TelegramRegistrationResult {
  duplicate: boolean;
  step: 'activity' | 'social_url' | 'profile_name' | 'complete';
  message: string;
  accountId?: string;
  tenantId?: string;
  profileId?: string;
  displayName?: string;
  grant?: number;
  available?: number;
}

const privateChatId = (value: string): boolean => /^-?\d{1,20}$/.test(value);
const telegramId = (value: string): boolean => /^\d{1,20}$/.test(value);
const clean = (value: string, max: number): string => value.trim().slice(0, max);

function parseSocialUrl(value: string): string | null {
  const candidate = clean(value, 2048);
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    return candidate;
  } catch { return null; }
}

/**
 * Durable private-chat registration state machine. Telegram identity and update
 * IDs must come from a verified Telegram webhook boundary, never request fields
 * supplied by an end user API client.
 */
export class TelegramRegistrationService {
  constructor(private readonly db: D1Database) {}

  async handle(input: TelegramRegistrationInput): Promise<TelegramRegistrationResult> {
    if (input.chatType !== 'private' || input.chatId !== input.telegramUserId || !privateChatId(input.chatId)
      || !telegramId(input.telegramUserId) || !Number.isSafeInteger(input.updateId) || input.updateId < 0
      || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.botIdentity)) {
      throw new Error('private_telegram_identity_required');
    }
    const receipt = await this.db.prepare(`SELECT response_json,telegram_user_id FROM telegram_update_receipts WHERE bot_identity=? AND update_id=?`)
      .bind(input.botIdentity, input.updateId).first<{ response_json: string; telegram_user_id: string }>();
    if (receipt) {
      if (receipt.telegram_user_id !== input.telegramUserId) throw new Error('telegram_update_identity_conflict');
      return { ...(JSON.parse(receipt.response_json) as TelegramRegistrationResult), duplicate: true };
    }

    const account = await this.db.prepare(`SELECT a.account_id, a.profile_id, p.display_name, b.grant_amount, b.consumed_amount, b.reserved_amount
      FROM telegram_accounts a JOIN telegram_profiles p USING(profile_id) JOIN account_budget_state b USING(account_id)
      WHERE a.bot_identity=? AND a.telegram_user_id=? AND a.deleted_at IS NULL`)
      .bind(input.botIdentity, input.telegramUserId)
      .first<{ account_id: string; profile_id: string; display_name: string; grant_amount: number; consumed_amount: number; reserved_amount: number }>();

    const session = await this.db.prepare(`SELECT * FROM telegram_onboarding_sessions WHERE bot_identity=? AND telegram_user_id=?`)
      .bind(input.botIdentity, input.telegramUserId).first<{
        step: 'activity'|'social_url'|'profile_name'|'complete'; activity_text: string|null; social_url: string|null;
        profile_name: string|null; consent_version: string; last_update_id: number;
      }>();

    let result: TelegramRegistrationResult;
    if (account) {
      result = { duplicate: false, step: 'complete', accountId: account.account_id, tenantId: account.account_id, profileId: account.profile_id,
        displayName: account.display_name, grant: account.grant_amount,
        available: Math.max(0, account.grant_amount - account.consumed_amount - account.reserved_amount),
        message: `Профиль уже создан. Доступно ${Math.max(0, account.grant_amount - account.consumed_amount - account.reserved_amount).toLocaleString('en-US')} токенов.` };
    } else if (!session && input.text !== '/start') {
      result = { duplicate: false, step: 'activity', message: 'Начните регистрацию командой /start.' };
    } else if (!session) {
      result = { duplicate: false, step: 'activity', message: 'Перед регистрацией ознакомьтесь с условиями обработки данных. Чем вы занимаетесь? Расскажите в паре предложений.' };
      const saved = await this.saveSession(input, 'activity', null, null, null);
      if (!saved) return this.handle(input);
    } else if (input.updateId <= session.last_update_id) {
      result = { duplicate: false, step: session.step, message: promptFor(session.step) };
    } else if (session.step === 'activity') {
      const activity = clean(input.text, 2000);
      if (activity.length < 12) result = { duplicate: false, step: 'activity', message: 'Расскажите чуть подробнее, в паре предложений: чем вы занимаетесь?' };
      else {
        const saved = await this.saveSession(input, 'social_url', activity, null, null);
        if (!saved) return this.handle(input);
        result = { duplicate: false, step: 'social_url', message: promptFor('social_url') };
      }
    } else if (session.step === 'social_url') {
      const social = parseSocialUrl(input.text);
      if (!social) result = { duplicate: false, step: 'social_url', message: 'Нужна ссылка формата https://… на ваш профиль. Мы не будем её открывать или проверять.' };
      else {
        const saved = await this.saveSession(input, 'profile_name', session.activity_text, social, null);
        if (!saved) return this.handle(input);
        result = { duplicate: false, step: 'profile_name', message: 'Как назвать профиль? Это необязательно — нажмите «Пропустить» или отправьте /skip.' };
      }
    } else if (session.step === 'profile_name') {
      const displayName = input.profileNameSkipped || input.text === '/skip' ? input.chatId : clean(input.profileName ?? input.text, 120);
      if (!displayName) result = { duplicate: false, step: 'profile_name', message: 'Введите имя профиля или отправьте /skip.' };
      else result = await this.finish(input, session.activity_text!, session.social_url!, displayName);
    } else {
      result = { duplicate: false, step: 'complete', message: 'Профиль уже создан.' };
    }

    const savedReceipt = await this.db.prepare(`INSERT INTO telegram_update_receipts(bot_identity,update_id,telegram_user_id,response_json,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(bot_identity,update_id) DO NOTHING`)
      .bind(input.botIdentity, input.updateId, input.telegramUserId, JSON.stringify(result), input.now ?? Date.now()).run();
    if (savedReceipt.meta.changes === 0) return this.handle(input);
    return result;
  }

  private async saveSession(input: TelegramRegistrationInput, step: 'activity'|'social_url'|'profile_name', activity: string|null, social: string|null, name: string|null): Promise<boolean> {
    const now = input.now ?? Date.now();
    const result = await this.db.prepare(`INSERT INTO telegram_onboarding_sessions(bot_identity,telegram_user_id,private_chat_id,step,activity_text,social_url,profile_name,consent_version,last_update_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_identity,telegram_user_id) DO UPDATE SET
      step=excluded.step,activity_text=COALESCE(excluded.activity_text,telegram_onboarding_sessions.activity_text),
      social_url=COALESCE(excluded.social_url,telegram_onboarding_sessions.social_url),profile_name=excluded.profile_name,
      last_update_id=excluded.last_update_id,updated_at=excluded.updated_at
      WHERE excluded.last_update_id > telegram_onboarding_sessions.last_update_id`)
      .bind(input.botIdentity,input.telegramUserId,input.chatId,step,activity,social,name,CONSENT_VERSION,input.updateId,now,now).run();
    return result.meta.changes > 0;
  }

  private async finish(input: TelegramRegistrationInput, activity: string, social: string, displayName: string): Promise<TelegramRegistrationResult> {
    const now = input.now ?? Date.now();
    const accountId = `acct-${crypto.randomUUID()}`;
    const profileId = `prof-${crypto.randomUUID()}`;
    const statements = [
      this.db.prepare(`INSERT INTO telegram_accounts(account_id,bot_identity,telegram_user_id,profile_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_identity,telegram_user_id) DO NOTHING`)
        .bind(accountId,input.botIdentity,input.telegramUserId,profileId,now),
      this.db.prepare(`INSERT INTO telegram_profiles(profile_id,account_id,display_name,activity_text,social_url,private_chat_id,consent_version,created_at,updated_at)
        SELECT profile_id,account_id,?,?,?,?,?,?,? FROM telegram_accounts WHERE bot_identity=? AND telegram_user_id=? AND deleted_at IS NULL
        ON CONFLICT(profile_id) DO NOTHING`)
        .bind(displayName,activity,social,input.chatId,CONSENT_VERSION,now,now,input.botIdentity,input.telegramUserId),
      this.db.prepare(`INSERT INTO account_budget_state(account_id,grant_amount,reserved_amount,consumed_amount,expires_at,updated_at)
        SELECT account_id,?,0,0,?,? FROM telegram_accounts WHERE bot_identity=? AND telegram_user_id=? AND deleted_at IS NULL
        ON CONFLICT(account_id) DO NOTHING`)
        .bind(STARTER_GRANT,now+STARTER_TTL_MS,now,input.botIdentity,input.telegramUserId),
      this.db.prepare(`INSERT INTO account_budget_ledger(entry_id,account_id,profile_id,kind,amount,idempotency_key,metadata_json,created_at)
        SELECT ?,account_id,profile_id,'grant',?,?,?,? FROM telegram_accounts WHERE bot_identity=? AND telegram_user_id=? AND deleted_at IS NULL
        ON CONFLICT(idempotency_key) DO NOTHING`)
        .bind(`grant-${input.botIdentity}-${input.telegramUserId}`,STARTER_GRANT,`starter:${input.botIdentity}:${input.telegramUserId}`,
          JSON.stringify({expiresAt:now+STARTER_TTL_MS,policy:'starter-v1'}),now,input.botIdentity,input.telegramUserId),
      this.db.prepare(`UPDATE telegram_onboarding_sessions SET step='complete',profile_name=?,last_update_id=?,updated_at=? WHERE bot_identity=? AND telegram_user_id=?`)
        .bind(displayName,input.updateId,now,input.botIdentity,input.telegramUserId),
    ];
    await this.db.batch(statements);
    const account = await this.db.prepare(`SELECT a.account_id,a.profile_id,p.display_name,b.grant_amount FROM telegram_accounts a
      JOIN telegram_profiles p USING(profile_id) JOIN account_budget_state b USING(account_id)
      WHERE a.bot_identity=? AND a.telegram_user_id=? AND a.deleted_at IS NULL`).bind(input.botIdentity,input.telegramUserId)
      .first<{account_id:string;profile_id:string;display_name:string;grant_amount:number}>();
    if (!account) throw new Error('registration_transaction_incomplete');
    return { duplicate:false,step:'complete',accountId:account.account_id,tenantId:account.account_id,profileId:account.profile_id,displayName:account.display_name,
      grant:account.grant_amount,available:account.grant_amount,
      message:`Профиль создан. Стартовый лимит: ${STARTER_GRANT.toLocaleString('en-US')} токенов на 12 месяцев. Напишите задачу, чтобы начать.` };
  }
}

function promptFor(step: 'activity'|'social_url'|'profile_name'|'complete'): string {
  if(step==='activity') return 'Чем вы занимаетесь? Расскажите в паре предложений.';
  if(step==='social_url') return 'Пришлите ссылку на соцсеть с непустым профилем старше месяца. Мы не проверяем её.';
  if(step==='profile_name') return 'Как назвать профиль? Необязательно — /skip.';
  return 'Профиль уже создан.';
}
