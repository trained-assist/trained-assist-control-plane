/**
 * PilotRouter — обёртка над PilotConfig для интеграции с IntakeService.
 *
 * Читает конфиг из окружения, принимает решение о маршрутизации,
 * логирует его структурированно, возвращает результат.
 *
 * Используется при приёме задачи (admit) — один раз, результат
 * сохраняется в durable Task Store и не пересчитывается.
 */
import { logStructured } from '../logging/structured-log';
import { readPilotConfig, decideRoute, validatePilotConfig, type PilotConfig, type PilotRoute } from './pilot-config';

export interface PilotRouterOptions {
  /** Переопределение конфига (для тестов). */
  config?: PilotConfig;
  /** env рантайма Workers; по умолчанию — пустой (пилот выключен). */
  env?: Record<string, string | undefined>;
}

export class PilotRouter {
  private config: PilotConfig;

  constructor(options: PilotRouterOptions = {}) {
    this.config = options.config ?? readPilotConfig(options.env ?? {});
  }

  /** Текущий конфиг (для инспекции в тестах и runbook). */
  getConfig(): PilotConfig {
    return this.config;
  }

  /**
   * Принять решение о маршрутизации и залогировать его.
   * Вызывается один раз при приёме задачи.
   */
  async route(params: {
    profileId: string;
    userTaskId: string;
    requestId: string | null;
    createdAt: number;
  }): Promise<PilotRoute> {
    const route = decideRoute(params.profileId, params.createdAt, this.config);

    logStructured({
      event: 'pilot.route_decision',
      level: 'info',
      profileId: params.profileId,
      userTaskId: params.userTaskId,
      requestId: params.requestId,
      pilotRoute: route.route,
      pilotReason: route.reason,
      pilotEnabled: this.config.enabled,
      pilotActivatedAt: this.config.activatedAt,
    });

    return route;
  }

  /**
   * Переключить конфиг на лету (для rollback).
   * В проде вызывается через обновление секрета / env;
   * в sandbox — прямым вызовом.
   */
  updateConfig(config: PilotConfig): void {
    const errors = validatePilotConfig(config);
    if (errors.length > 0) {
      logStructured({
        event: 'pilot.config_invalid',
        level: 'error',
        reason: errors.join('; '),
      });
      throw new Error(`Pilot config invalid: ${errors.join('; ')}`);
    }
    this.config = config;
    logStructured({
      event: 'pilot.config_updated',
      level: 'info',
      pilotEnabled: config.enabled,
      pilotActivatedAt: config.activatedAt,
    });
  }
}

/** Синглтон для использования в HTTP-слое (read-only, config читается из env). */
export const defaultPilotRouter = new PilotRouter();