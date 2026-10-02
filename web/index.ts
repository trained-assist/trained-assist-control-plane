/**
 * Отдельный Worker web-среза (M1, шаг 7): тонкий клиент к control plane.
 *
 * Подключение — только из окружения (см. `web/config.ts`):
 *   CONTROL_PLANE_URL            — базовый URL control plane (без секретов);
 *   CONTROL_PLANE_PRINCIPAL      — проверенная аутентификация (C01);
 *   CONTROL_PLANE_PROFILE        — профиль песочницы;
 *   CONTROL_PLANE_API_KEY        — необязательный bearer-ключ (C13);
 *   CONTROL_PLANE_SESSION_ID     — сессия-источник (C01);
 *   WEB_EVENT_TRANSPORT          — auto | events-endpoint | status-history.
 *
 * Секреты в репозитории и в логах не появляются: ключ читается из env и
 * уходит только в заголовок запроса.
 */
import { ControlPlaneClient } from './control-plane-client';
import { readWebConfig, type WebEnv } from './config';
import { WebApp } from './app';

export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    const config = readWebConfig(env);
    const client = new ControlPlaneClient(config);
    const app = new WebApp({ client, profileId: config.profileId, sessionId: config.sessionId });
    const result = await app.handle(request);
    return new Response(result.body, {
      status: result.status,
      headers: {
        'content-type': result.contentType,
        ...(result.location ? { location: result.location } : {}),
      },
    });
  },
};