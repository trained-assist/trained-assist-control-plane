// Импорты `?raw` (vite): файлы корпуса и артефакта решений читаются как текст.
declare module '*?raw' {
  const content: string;
  export default content;
}

// Санитизатор evidence живёт в .mjs (его запускает node напрямую, без бандла),
// поэтому для тестов — декларация модуля, а не импорт реализации.
declare module '*.mjs' {
  export interface SanitizedProbe {
    probe: string;
    value: Record<string, unknown>;
  }
  export interface SanitizedEvidence {
    events: string[];
    transcript: string;
    digest: string;
  }
  export function sanitizeP20Evidence(params: {
    lines: string[];
    secret?: string;
    probes?: SanitizedProbe[];
  }): SanitizedEvidence;
  export const PROBE_FILES: string[];
}
