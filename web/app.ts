/**
 * Роуты web-слоя: страница одной conversation, отправка сообщения, ответ в
 * ожидании, явное продолжение после потери связи, байты артефакта.
 *
 * Роутер не знает про control plane напрямую — только про `ConversationSession`
 * и `ControlPlaneClient`. Поэтому его можно поднять и в отдельном Worker
 * (`web/index.ts`), и в тестах без рантайма workerd.
 */
import type { ControlPlaneClient } from './control-plane-client';
import { ControlPlaneError } from './control-plane-client';
import {
  ConversationNotFoundError,
  ConversationSession,
  MemoryTurnIndexStore,
  NoAwaitingInputError,
  type ConversationView,
  type TurnIndexStore,
} from './conversation';
import { renderConversationPage } from './page';
import { logWeb, type WebLogSink } from './log';

export interface WebAppOptions {
  client: ControlPlaneClient;
  store?: TurnIndexStore;
  logSink?: WebLogSink;
  /** Профиль песочницы: адресат задач в Task Store. */
  profileId: string;
  /** Имя сессии-источника (C01 sessionId). */
  sessionId?: string | null;
  maxTurns?: number;
}

export interface WebAppResult {
  status: number;
  body: string;
  contentType: string;
  location?: string;
}

const json = (value: unknown, status = 200): WebAppResult => ({
  status,
  body: JSON.stringify(value, null, 1),
  contentType: 'application/json; charset=utf-8',
});

const html = (body: string, status = 200): WebAppResult => ({
  status,
  body,
  contentType: 'text/html; charset=utf-8',
});

const text = (body: string, status = 200): WebAppResult => ({
  status,
  body,
  contentType: 'text/plain; charset=utf-8',
});

/** Тело формы читаем как байты: `.text()` на form-urlencoded в workerd предупреждает. */
const readForm = async (request: Request): Promise<URLSearchParams> => {
  const bytes = await request.arrayBuffer();
  return new URLSearchParams(new TextDecoder().decode(bytes));
};

export class WebApp {
  private readonly store: TurnIndexStore;
  private readonly logSink: WebLogSink | undefined;

  constructor(private readonly options: WebAppOptions) {
    this.store = options.store ?? new MemoryTurnIndexStore();
    this.logSink = options.logSink;
  }

  private log(fields: Parameters<typeof logWeb>[0]): void {
    logWeb(fields, this.logSink);
  }

  private session(conversationId: string): ConversationSession {
    return new ConversationSession(this.options.client, {
      conversationId,
      profileId: this.options.profileId,
      store: this.store,
      logSink: this.logSink,
      maxTurns: this.options.maxTurns,
    });
  }

  async handle(request: Request): Promise<WebAppResult> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    // /web/healthz · /web/conversations/:id · /web/conversations/:id/messages
    // · /web/conversations/:id/answer · /web/conversations/:id/continue
    // · /web/artifacts/:taskId/:ref
    try {
      if (parts[0] === 'web' && parts[1] === 'healthz') {
        return json({
          ok: true,
          service: 'trained-assist-web-slice',
          controlPlane: this.options.client.eventTransport ?? 'unknown',
          profileId: this.options.profileId,
        });
      }
      if (parts[0] === 'web' && parts[1] === 'conversations' && !parts[2] && request.method === 'POST') {
        return await this.createConversation(request);
      }
      if (parts[0] === 'web' && parts[1] === 'conversations' && parts[2] && !parts[3]) {
        return await this.conversationPage(parts[2]!, request);
      }
      if (parts[0] === 'web' && parts[1] === 'conversations' && parts[2] && parts[3] === 'messages') {
        return await this.postMessage(parts[2]!, request);
      }
      if (parts[0] === 'web' && parts[1] === 'conversations' && parts[2] && parts[3] === 'answer') {
        return await this.postAnswer(parts[2]!, request);
      }
      if (parts[0] === 'web' && parts[1] === 'conversations' && parts[2] && parts[3] === 'continue') {
        return await this.postContinue(parts[2]!, request);
      }
      if (
        parts[0] === 'web' &&
        parts[1] === 'conversations' &&
        parts[2] &&
        parts[3] === 'artifacts' &&
        parts[4]
      ) {
        return await this.artifact(parts[2]!, parts[4]!, request);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return this.error(e);
    }
  }

  private async createConversation(request: Request): Promise<WebAppResult> {
    const body = await readForm(request);
    const conversationId = (body.get('conversationId') ?? '').trim();
    if (!conversationId || !/^[a-zA-Z0-9._-]{1,120}$/.test(conversationId)) {
      return json({ error: 'conversationId must be 1..120 chars [a-zA-Z0-9._-]' }, 400);
    }
    const session = this.session(conversationId);
    const view = await session.create();
    this.log({ event: 'web.conversation.created', conversationId, profileId: view.profileId });
    return this.redirectOrJson(request, conversationId, view);
  }

  private async conversationPage(conversationId: string, request: Request): Promise<WebAppResult> {
    const session = this.session(conversationId);
    const view = await session.open();
    if (request.headers.get('accept')?.includes('application/json') || request.url.includes('format=json')) {
      return json(view);
    }
    return html(renderConversationPage(view));
  }

  private async postMessage(conversationId: string, request: Request): Promise<WebAppResult> {
    const body = await readForm(request);
    const textValue = (body.get('text') ?? '').trim();
    if (!textValue) return json({ error: 'text is required' }, 400);
    const session = this.session(conversationId);
    const result = await session.sendMessage(textValue);
    this.log({
      event: 'web.page.message',
      conversationId,
      userTaskId: result.userTaskId,
      requestId: result.requestId,
      reason: result.duplicate ? 'idempotent_replay' : 'sent',
    });
    return this.redirectOrJson(request, conversationId, result.view);
  }

  private async postAnswer(conversationId: string, request: Request): Promise<WebAppResult> {
    const body = await readForm(request);
    const textValue = (body.get('text') ?? '').trim();
    if (!textValue) return json({ error: 'text is required' }, 400);
    const session = this.session(conversationId);
    const result = await session.answer(textValue);
    this.log({
      event: 'web.page.answer',
      conversationId,
      userTaskId: result.userTaskId,
      requestId: result.requestId,
      reason: result.duplicate ? 'idempotent_replay' : result.delivered ? 'delivered' : 'not_delivered',
    });
    return this.redirectOrJson(request, conversationId, result.view);
  }

  private async postContinue(conversationId: string, request: Request): Promise<WebAppResult> {
    const body = await readForm(request);
    const seq = Number(body.get('seq'));
    if (!Number.isInteger(seq)) return json({ error: 'seq is required' }, 400);
    const session = this.session(conversationId);
    const result = await session.continueUnknown(seq, body.get('instructions') ?? undefined);
    this.log({
      event: 'web.page.continue',
      conversationId,
      userTaskId: result.userTaskId,
      runId: result.runId,
      reason: 'explicit_user_continuation',
      generation: result.generation,
    });
    return this.redirectOrJson(request, conversationId, result.view);
  }

  private async artifact(conversationId: string, ref: string, request: Request): Promise<WebAppResult> {
    const session = this.session(conversationId);
    const view = await session.open();
    const entry = view.artifacts.find((a) => a.ref === ref);
    if (!entry) return json({ error: 'artifact not found in this conversation' }, 404);
    try {
      const artifact = await this.options.client.artifact(entry.userTaskId, ref);
      return {
        status: 200,
        body: new TextDecoder().decode(artifact.body),
        contentType: artifact.contentType ?? 'application/octet-stream',
      };
    } catch (e) {
      // Байты артефакта — отдельная договорённость (Runner/GCS); ссылка и манифест
      // уже видны в журнале, поэтому честно отдаём причину, а не выдумываем файл.
      const reason = e instanceof ControlPlaneError ? `control_plane_${e.status}` : 'artifact_source_unavailable';
      this.log({ event: 'web.artifact.unavailable', userTaskId: entry.userTaskId, reason });
      return json(
        {
          error: 'artifact bytes are not served by this control plane build',
          ref,
          reason,
          manifest: { ref, sizeBytes: null, sha256: null, contentType: null },
        },
        502,
      );
    }
  }

  private redirectOrJson(request: Request, conversationId: string, view: ConversationView): WebAppResult {
    if (request.headers.get('accept')?.includes('application/json') || request.url.includes('format=json')) {
      return json(view);
    }
    return { status: 303, body: '', contentType: 'text/plain; charset=utf-8', location: `/web/conversations/${conversationId}` };
  }

  private error(e: unknown): WebAppResult {
    if (e instanceof ConversationNotFoundError) {
      return json({ error: e.message, name: e.name }, 404);
    }
    if (e instanceof NoAwaitingInputError) {
      return json({ error: e.message, name: e.name }, 409);
    }
    if (e instanceof ControlPlaneError) {
      this.log({ event: 'web.error', reason: `control_plane_${e.status}` });
      return json({ error: e.message, name: e.name, status: e.status }, e.status >= 400 && e.status < 600 ? e.status : 502);
    }
    const message = String((e as Error)?.message ?? e);
    this.log({ event: 'web.error', reason: 'internal' });
    return json({ error: message, name: 'WebError' }, 500);
  }
}

