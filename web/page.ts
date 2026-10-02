/**
 * Страница одной conversation. Рендер без зависимостей: страница — тонкая
 * проекция журнала, а не источник состояния. Ничего, что видит человек, не
 * приходит в control plane напрямую: форма -> намерение пользователя ->
`ConversationSession` -> HTTP-адаптер.
 */
import type { ConversationView, TurnView } from './conversation';
import { artifactPath } from './conversation';

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const badge = (turn: TurnView): string => {
  if (turn.unknownOutcome) return '<span class="badge unknown">исход неизвестен</span>';
  if (turn.terminal === 'done') return '<span class="badge done">готово</span>';
  if (turn.terminal === 'failed') return '<span class="badge failed">ошибка</span>';
  if (turn.terminal === 'cancelled') return '<span class="badge cancelled">отменено</span>';
  if (turn.awaiting && turn.awaiting.consumedByRun === null) return '<span class="badge waiting">ждёт ответа</span>';
  return `<span class="badge running">${esc(turn.status)}</span>`;
};

const turnBlock = (turn: TurnView, conversationId: string): string => {
  const facts = [
    `ход ${turn.seq}`,
    `задача ${turn.userTaskId}`,
    turn.currentRunId ? `попытка ${turn.currentRunId}` : null,
    `поколение ${turn.generation}`,
    `курсор ${turn.cursor}`,
    `запусков ${turn.runStartedCount}`,
    turn.answersUsed ? `ответов использовано ${turn.answersUsed}` : null,
    turn.wakeDeliveryInterrupted ? '<span class="warn">доставка пробуждения была прервана</span>' : null,
    turn.fenced ? `fencing ${turn.fenced}` : null,
    turn.lateWritesRejected ? `поздних записей отклонено ${turn.lateWritesRejected}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const awaiting = turn.awaiting
    ? `<p class="awaiting">Уточнение: ${esc(turn.awaiting.question)} <em>${
        turn.awaiting.consumedByRun
          ? `ответ принят (попытка ${esc(turn.awaiting.consumedByRun)})`
          : 'ответ не получен'
      }</em></p>`
    : '';

  const artifacts = turn.artifacts.length
    ? `<ul class="artifacts">${turn.artifacts
        .map(
          (a) =>
            `<li><a href="${esc(artifactPath(conversationId, turn.userTaskId, a.ref))}">артефакт ${esc(a.ref)}</a></li>`,
        )
        .join('')}</ul>`
    : '';

  const result = turn.terminal
    ? `<pre class="result">${esc(JSON.stringify(turn.result, null, 2))}</pre>`
    : '';

  const continuation = turn.unknownOutcome
    ? `<form method="post" action="/web/conversations/${esc(conversationId)}/continue">
         <input type="hidden" name="seq" value="${turn.seq}" />
         <button type="submit">продолжить явной новой попыткой</button>
       </form>
       <p class="hint">Автоматического перезапуска нет: исход попытки неизвестен, продолжение — новая попытка с новым runId.</p>`
    : '';

  return `<li class="turn ${esc(turn.status)}">
      <div class="head"><span class="who">${turn.kind === 'new' ? 'вы' : 'ответ'}</span> ${badge(turn)}</div>
      <p class="text">${esc(turn.text)}</p>
      <p class="facts">${facts}</p>
      ${awaiting}${result}${artifacts}${continuation}
    </li>`;
};

export function renderConversationPage(view: ConversationView): string {
  const ask =
    view.awaiting
      ? `<section class="await">
           <h2>Нужно ваше уточнение</h2>
           <p>${esc(view.awaiting.question)}</p>
           <form method="post" action="/web/conversations/${esc(view.conversationId)}/answer">
             <input type="hidden" name="seq" value="${view.awaiting.seq}" />
             <input type="hidden" name="messageKey" value="web:${esc(view.conversationId)}:m${view.nextSeq}" />
             <textarea name="text" rows="2" required></textarea>
             <button type="submit">ответить</button>
           </form>
           <p class="hint">Ключ сообщения ${esc(`web:${view.conversationId}:m${view.nextSeq}`)} — повтор отправки не создаст второй сигнал.</p>
         </section>`
      : '';

  const send = `<section class="send">
      <h2>Новое сообщение</h2>
      <form method="post" action="/web/conversations/${esc(view.conversationId)}/messages">
        <input type="hidden" name="messageKey" value="web:${esc(view.conversationId)}:m${view.nextSeq}" />
        <textarea name="text" rows="2" required></textarea>
        <button type="submit">отправить</button>
      </form>
    </section>`;

  const transport = view.transportNote
    ? `<p class="hint warn">${esc(view.transportNote)}</p>`
    : `<p class="hint">журнал: ${esc(view.transport ?? '…')}, курсор = последовательность событий</p>`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Разговор ${esc(view.conversationId)}</title>
<style>
 body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; color: #1a1a1a; }
 .badge { border-radius: 4px; padding: 0 .4em; font-size: .85em; background: #eee; }
 .done { background: #dff5df; } .failed { background: #fbe0e0; } .unknown { background: #fff3cd; }
 .waiting { background: #e2efff; } .cancelled { background: #eee; }
 .turns { list-style: none; padding: 0; }
 .turn { border: 1px solid #ddd; border-radius: 6px; padding: .6rem .8rem; margin: .6rem 0; }
 .facts, .hint { color: #666; font-size: .85em; }
 .result { background: #f6f6f6; padding: .5rem; overflow-x: auto; }
 .warn { color: #8a6100; }
 textarea { width: 100%; }
</style>
</head>
<body>
<h1>Разговор ${esc(view.conversationId)}</h1>
<p class="hint">профиль ${esc(view.profileId)} · сообщений ${view.turns.length} · журнал ${esc(view.transport ?? '…')}</p>
${transport}
${ask}
<h2>Ходы</h2>
<ol class="turns">${view.turns.map((t) => turnBlock(t, view.conversationId)).join('')}</ol>
${send}
</body>
</html>`;
}

/** Маленький текстовый вид для curl-прогонов и отчётов. */
export function renderConversationText(view: ConversationView): string {
  const lines: string[] = [
    `conversation ${view.conversationId} profile=${view.profileId} transport=${view.transport ?? '?'} messages=${view.turns.length}`,
  ];
  for (const turn of view.turns) {
    lines.push(
      `#${turn.seq} ${turn.kind} ${turn.status} task=${turn.userTaskId} run=${turn.currentRunId ?? '-'} gen=${turn.generation} cursor=${turn.cursor} starts=${turn.runStartedCount} answers=${turn.answersUsed}`,
    );
    lines.push(`    text: ${turn.text}`);
    if (turn.unknownOutcome) lines.push('    ! исход попытки неизвестен (не failed), нужен явный continue');
    if (turn.wakeDeliveryInterrupted) lines.push('    ! доставка пробуждения прервана, ответ сохранён');
    if (turn.awaiting) {
      lines.push(
        `    awaiting ${turn.awaiting.id}: ${turn.awaiting.question} [${
          turn.awaiting.consumedByRun ? `ответ принят ${turn.awaiting.consumedByRun}` : 'ждём ответа'
        }]`,
      );
    }
    for (const a of turn.artifacts) lines.push(`    artifact ${a.ref} -> ${a.url}`);
    if (turn.terminal) lines.push(`    result: ${JSON.stringify(turn.result)}`);
  }
  return lines.join('\n');
}