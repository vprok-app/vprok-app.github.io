// Voice probe page (INT-002, H-007). Throwaway: removed with spikes/voice-probe/.
// Records a phrase, sends it to the probe Worker with the user's Firebase ID token,
// shows the transcript and items, and collects two marks per phrase. History is kept in
// localStorage on this phone and sent to the Worker as the report.

import { initializeApp } from '../firebasejs/12.17.0/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  onAuthStateChanged, signInWithEmailAndPassword,
} from '../firebasejs/12.17.0/firebase-auth.js';
import { WORKER_ORIGIN } from './worker-origin.js';
import { startWavCapture } from './wav.js';

const GOAL = 20;
const STORE = 'vprok-voice-probe-v1';
const CATEGORY_RU = {
  groceries: 'Продукты', eating_out: 'Кафе', transport: 'Транспорт', household: 'Дом',
  health: 'Здоровье', clothing: 'Одежда', fun: 'Развлечения', other: 'Другое',
};

const $ = (id) => document.getElementById(id);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let auth = null;
let state = load();
let current = null;      // the phrase being shown: { n, blob, mime, result, error, marks }
let recording = null;    // { stop(): Promise<Blob> }
let askedMicThisLaunch = false;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (s && Array.isArray(s.phrases)) return s;
  } catch { /* a broken store starts over */ }
  return { phrases: [], micAnswers: [] };
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private mode: history lives only in memory */ }
}

function show(id, visible = true) { $(id).hidden = !visible; }

function text(el, value) { el.textContent = value; return el; }

function el(tag, cls, value) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
}

function money(minor) {
  if (minor === null || minor === undefined) return 'сумма?';
  return `${(minor / 100).toFixed(2).replace('.', ',')} р.`;
}

// ---- server -------------------------------------------------------------------------

async function checkServer() {
  const box = $('server-status');
  if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/.test(WORKER_ORIGIN)) {
    box.className = 'error';
    text(box, 'Адрес сервера не задан (worker-origin.js). Это делает Claude на Mac.');
    return null;
  }
  const t0 = performance.now();
  try {
    const res = await fetch(`${WORKER_ORIGIN}/health`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ms = Math.round(performance.now() - t0);
    box.className = 'ok';
    text(box, `Сервер доступен (${ms} мс)${standalone ? ' · иконка на экране' : ' · Safari'}`);
    state.lastHealth = { ok: true, ms, at: new Date().toISOString(), standalone };
    save();
    const cfg = await (await fetch(`${WORKER_ORIGIN}/config`, { cache: 'no-store' })).json();
    return cfg;
  } catch (e) {
    box.className = 'error';
    text(box, `Сервер недоступен: ${e.message}. Если VPN выключен, это и есть ответ пробы.`);
    state.lastHealth = { ok: false, error: String(e.message), at: new Date().toISOString(), standalone };
    save();
    return null;
  }
}

async function call(path, init) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${WORKER_ORIGIN}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}

// ---- sign-in ------------------------------------------------------------------------

function initAuth(cfg) {
  const app = initializeApp({ apiKey: cfg.apiKey, projectId: cfg.projectId });
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  onAuthStateChanged(auth, (user) => {
    show('signin', !user);
    show('recorder', !!user);
    renderReport();
  });
  $('signin-btn').addEventListener('click', async () => {
    const err = $('signin-error');
    show('signin-error', false);
    $('signin-btn').disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
    } catch (e) {
      text(err, `Не вышло войти: ${e.code ?? e.message}`);
      show('signin-error');
    } finally {
      $('signin-btn').disabled = false;
    }
  });
}

// ---- recording ----------------------------------------------------------------------

function nativeMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function startRecording() {
  const t0 = performance.now();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const micMs = Math.round(performance.now() - t0);
  const release = () => stream.getTracks().forEach((t) => t.stop());

  if ($('format').value === 'wav') {
    const cap = startWavCapture(stream);
    return { micMs, stop: async () => { const b = await cap.stop(); release(); return b; } };
  }
  const mime = nativeMime();
  if (mime === null) throw new Error('MediaRecorder недоступен');
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.start();
  return {
    micMs,
    stop: () => new Promise((resolve) => {
      rec.onstop = () => { release(); resolve(new Blob(parts, { type: rec.mimeType || mime || 'application/octet-stream' })); };
      rec.stop();
    }),
  };
}

async function onRecordTap() {
  const btn = $('record-btn');
  if (!recording) {
    try {
      recording = await startRecording();
    } catch (e) {
      text($('record-hint'), `Микрофон: ${e.name ?? ''} ${e.message}`);
      return;
    }
    btn.classList.add('recording');
    text(btn, 'Готово');
    text($('record-hint'), 'Говорите… Нажмите «Готово», когда закончите.');
    if (!askedMicThisLaunch) {
      askedMicThisLaunch = true;
      $('mic-question').dataset.micMs = String(recording.micMs);
      show('mic-question');
    }
    return;
  }
  const blob = await recording.stop();
  recording = null;
  btn.classList.remove('recording');
  text(btn, 'Записать');
  text($('record-hint'), '');
  current = { n: state.phrases.length + 1, blob, mime: blob.type, format: $('format').value, marks: {} };
  await send();
}

// ---- sending and marks ---------------------------------------------------------------

async function send() {
  show('recorder', false);
  show('result');
  show('marks', false);
  show('reparse', false);
  show('retry-btn', false);
  show('next-btn', false);
  const body = $('result-body');
  body.replaceChildren(el('p', 'muted', 'Распознаю и разбираю…'));
  const t0 = performance.now();
  let res;
  try {
    res = await call('/transcribe', { method: 'POST', headers: { 'Content-Type': current.mime || 'application/octet-stream' }, body: current.blob });
  } catch (e) {
    res = { status: 0, body: { error: 'network', detail: e.message } };
  }
  current.totalMs = Math.round(performance.now() - t0);
  current.status = res.status;
  if (res.status === 200) {
    current.result = res.body;
    current.error = null;
    renderResult();
    show('marks');
    show('reparse');
  } else {
    current.error = res.body ?? { error: `HTTP ${res.status}` };
    current.result = res.body?.transcript ? { transcript: res.body.transcript, items: [] } : null;
    renderError();
    show('retry-btn');
    show('next-btn');
    text($('next-btn'), 'Пропустить фразу');
    record();
  }
}

function renderResult() {
  const body = $('result-body');
  const r = current.result;
  const nodes = [el('p', 'transcript', `«${r.transcript || '(пусто)'}»`)];
  const list = el('ul', 'items');
  for (const item of r.items) {
    const li = el('li');
    const left = el('span', null, `${CATEGORY_RU[item.category] ?? item.category} · ${item.note || '—'}`);
    const right = el('span', null, money(item.amountMinor));
    li.append(left, right);
    if (!item.confident) li.append(el('span', 'badge', 'не уверен'));
    list.append(li);
  }
  if (!r.items.length) nodes.push(el('p', 'muted', 'Трат не нашлось.'));
  nodes.push(list);
  const t = r.timings ?? {};
  nodes.push(el('p', 'muted', `${current.mime || 'формат?'} · ${Math.round((r.audio?.bytes ?? 0) / 1024)} КБ · распознавание ${t.whisperMs ?? '?'} мс · разбор ${t.llmMs ?? '?'} мс · всего ${current.totalMs} мс`));
  if (current.reparsed) {
    for (const rp of current.reparsed) {
      const p = el('p', 'muted', `${rp.model.split('/').pop()}: ${rp.items.map((i) => `${CATEGORY_RU[i.category] ?? i.category} ${money(i.amountMinor)}`).join('; ') || 'нет трат'}`);
      nodes.push(p);
    }
  }
  body.replaceChildren(...nodes);
}

function renderError() {
  const e = current.error;
  const nodes = [el('p', 'error', `Ошибка: ${e.error}${e.detail ? ` — ${e.detail}` : ''}`)];
  if (e.error === 'uid_not_allowed') nodes.push(el('p', null, `Ваш uid: ${e.uid}. Передайте его Claude на Mac.`));
  if (e.error === 'whisper_failed' && current.format !== 'wav') nodes.push(el('p', null, 'Похоже, сервер не принял формат телефона. Переключите «Формат» на WAV и запишите фразу снова.'));
  if (current.result?.transcript) nodes.push(el('p', 'transcript', `«${current.result.transcript}»`));
  $('result-body').replaceChildren(...nodes);
}

function onMark(ev) {
  const b = ev.target.closest('button[data-mark]');
  if (!b) return;
  current.marks[b.dataset.mark] = b.dataset.value;
  for (const sib of document.querySelectorAll(`button[data-mark="${b.dataset.mark}"]`)) sib.classList.toggle('selected', sib === b);
  if (current.marks.amounts && current.marks.categories) {
    record();
    text($('next-btn'), 'Следующая фраза');
    show('next-btn');
  }
}

async function onReparse() {
  const model = $('model').value;
  $('reparse-btn').disabled = true;
  try {
    const res = await call('/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: current.result.transcript, model }) });
    if (res.status === 200) {
      current.reparsed = [...(current.reparsed ?? []), { model, items: res.body.items, llmMs: res.body.timings?.llmMs }];
      renderResult();
      if (current.marks.amounts && current.marks.categories) record();
    } else {
      $('result-body').append(el('p', 'error', `Другая модель: ${res.body?.error ?? res.status}`));
    }
  } finally {
    $('reparse-btn').disabled = false;
  }
}

// Writes (or rewrites) the current phrase into the history.
function record() {
  const entry = {
    n: current.n,
    at: new Date().toISOString(),
    standalone,
    format: current.format,
    mime: current.mime,
    status: current.status,
    totalMs: current.totalMs,
    transcript: current.result?.transcript ?? null,
    items: current.result?.items ?? [],
    audio: current.result?.audio ?? null,
    timings: current.result?.timings ?? null,
    model: current.result?.model ?? null,
    reparsed: current.reparsed ?? [],
    error: current.error ?? null,
    marks: { ...current.marks },
  };
  const i = state.phrases.findIndex((p) => p.n === entry.n);
  if (i >= 0) state.phrases[i] = entry; else state.phrases.push(entry);
  save();
  renderReport();
}

function next() {
  current = null;
  for (const b of document.querySelectorAll('button[data-mark]')) b.classList.remove('selected');
  show('result', false);
  show('recorder');
  renderReport();
}

// ---- report -------------------------------------------------------------------------

function scores() {
  const scored = state.phrases.filter((p) => p.marks.amounts && p.marks.categories);
  return {
    scored: scored.length,
    amountsOk: scored.filter((p) => p.marks.amounts === 'ok').length,
    categoriesOk: scored.filter((p) => p.marks.categories === 'ok').length,
    failed: state.phrases.filter((p) => p.error).length,
  };
}

function renderReport() {
  const s = scores();
  text($('counter'), `Фраза ${Math.min(s.scored + 1, GOAL)} из ${GOAL}${s.scored >= GOAL ? ' (цель набрана, можно ещё)' : ''}`);
  show('report', state.phrases.length > 0);
  text($('summary'), `Оценено фраз: ${s.scored}. Суммы верны: ${s.amountsOk} из ${s.scored}. Категории верны: ${s.categoriesOk} из ${s.scored}. Ошибок сервера: ${s.failed}.`);
  const list = $('history');
  list.replaceChildren(...state.phrases.map((p) => {
    const marks = p.error ? `ошибка ${p.error.error}` : `суммы ${p.marks.amounts === 'ok' ? '✓' : p.marks.amounts ? '✗' : '?'}, категории ${p.marks.categories === 'ok' ? '✓' : p.marks.categories ? '✗' : '?'}`;
    return el('li', null, `${p.transcript ? `«${p.transcript}»` : '(нет текста)'} — ${marks}`);
  }));
}

function reportJson() {
  return {
    probe: 'voice-expenses H-007',
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    standalone,
    lastHealth: state.lastHealth ?? null,
    micAnswers: state.micAnswers,
    scores: scores(),
    phrases: state.phrases,
  };
}

function reportMarkdown() {
  const r = reportJson();
  const s = r.scores;
  const lines = [
    `# Voice probe report ${r.generatedAt}`,
    '',
    `Scored ${s.scored}; amounts right ${s.amountsOk}/${s.scored}; categories right ${s.categoriesOk}/${s.scored}; server errors ${s.failed}.`,
    `UA: ${r.userAgent}`,
    `Mic prompts: ${JSON.stringify(r.micAnswers)}`,
    '',
    '| # | mode | mime | amounts | categories | ms | transcript | items |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const p of r.phrases) {
    const items = p.items.map((i) => `${i.category} ${money(i.amountMinor)}${i.confident ? '' : '?'}`).join('; ');
    lines.push(`| ${p.n} | ${p.standalone ? 'icon' : 'safari'} | ${p.mime} | ${p.marks.amounts ?? '-'} | ${p.marks.categories ?? '-'} | ${p.totalMs} | ${p.error ? `ERROR ${p.error.error}` : (p.transcript ?? '').replace(/\|/g, '/')} | ${items} |`);
  }
  return lines.join('\n');
}

async function onSendReport() {
  const status = $('report-status');
  text(status, 'Отправляю…');
  try {
    const res = await call('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportJson()) });
    if (res.status === 200 && res.body?.stored) text(status, 'Отчёт на сервере. Claude на Mac его заберёт.');
    else if (res.status === 200) text(status, 'Сервер не хранит отчёты. Нажмите «Скопировать отчёт».');
    else text(status, `Не отправилось: ${res.body?.error ?? res.status}`);
  } catch (e) {
    text(status, `Не отправилось: ${e.message}`);
  }
}

async function onCopyReport() {
  try {
    await navigator.clipboard.writeText(reportMarkdown());
    text($('report-status'), 'Скопировано.');
  } catch (e) {
    text($('report-status'), `Не скопировалось: ${e.message}`);
  }
}

function onMicAnswer(ev) {
  const b = ev.target.closest('button[data-mic]');
  if (!b) return;
  state.micAnswers.push({ at: new Date().toISOString(), standalone, asked: b.dataset.mic === 'yes', micMs: Number($('mic-question').dataset.micMs) });
  save();
  show('mic-question', false);
}

function onClear() {
  if (!window.confirm('Удалить все записанные фразы на этом телефоне?')) return;
  state = { phrases: [], micAnswers: [] };
  save();
  renderReport();
}

// ---- start --------------------------------------------------------------------------

$('record-btn').addEventListener('click', onRecordTap);
$('marks').addEventListener('click', onMark);
$('mic-question').addEventListener('click', onMicAnswer);
$('reparse-btn').addEventListener('click', onReparse);
$('retry-btn').addEventListener('click', send);
$('next-btn').addEventListener('click', next);
$('send-report-btn').addEventListener('click', onSendReport);
$('copy-report-btn').addEventListener('click', onCopyReport);
$('clear-btn').addEventListener('click', onClear);

renderReport();
const cfg = await checkServer();
if (cfg?.apiKey && cfg?.projectId) initAuth(cfg);
