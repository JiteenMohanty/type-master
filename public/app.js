import { MODES, MIN_COMMIT_ACCURACY, targetEnd, computeStats, chapterProgress, chapterAt, isWordStart } from '/shared/engine.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const pct = (x) => `${Math.floor(x * 100)}%`;

const state = {
  book: null,
  me: null,
  mode: localStorageGet('tm_mode') || 't60',
  startPos: null, // explicit start chosen from the chapter index; null = resume
  test: null,
};

function localStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---------- routing ----------

const VIEWS = ['auth', 'practice', 'chapters', 'profile', 'leaderboard'];

function route() {
  let view = location.hash.replace(/^#\//, '') || 'practice';
  if (!state.me) view = 'auth';
  else if (!VIEWS.includes(view) || view === 'auth') view = 'practice';
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('#nav').hidden = $('#userchip').hidden = !state.me;
  if (view === 'practice') showPractice();
  if (view === 'chapters') renderChapters();
  if (view === 'profile') renderProfile();
  if (view === 'leaderboard') renderLeaderboard();
}

function go(view) {
  if (location.hash === `#/${view}`) route();
  else location.hash = `#/${view}`;
}

// ---------- auth ----------

let authMode = 'login';
document.querySelectorAll('[data-auth]').forEach((btn) => btn.addEventListener('click', () => {
  authMode = btn.dataset.auth;
  document.querySelectorAll('[data-auth]').forEach((b) => b.classList.toggle('active', b === btn));
  $('#auth-submit').textContent = authMode === 'login' ? 'Log in' : 'Create account';
  $('#auth-form').password.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').hidden = true;
}));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const { me } = await api(`/api/${authMode}`, { username: form.username.value, password: form.password.value });
    form.reset();
    setMe(me);
    go('practice');
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  state.me = null;
  state.test = null;
  go('auth');
});

function setMe(me) {
  state.me = me;
  $('#chip-name').textContent = me.username;
  $('#chip-level').textContent = `Level ${me.level}`;
}

// ---------- practice ----------

const modesEl = $('#modes');
for (const [id, m] of Object.entries(MODES)) {
  const b = document.createElement('button');
  b.textContent = m.label;
  b.dataset.mode = id;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => {
    state.mode = id;
    localStorageSet('tm_mode', id);
    newTest(state.test?.startPos);
  });
  modesEl.append(b);
}

const input = $('#input');
const box = $('#typing-box');
const textEl = $('#text');

function resumePos() {
  const text = state.book.text;
  let pos = state.me.position;
  if (pos >= text.length) return 0; // finished the book: start again
  while (pos > 0 && !isWordStart(text, pos)) pos--;
  return pos;
}

function showPractice() {
  if (!state.test || state.test.finished) {
    if (!state.test || state.test.submitted) newTest(state.startPos ?? resumePos());
  }
  state.startPos = null;
  focusInput();
}

function newTest(startPos = resumePos()) {
  clearInterval(state.test?.timer);
  const text = state.book.text;
  const end = targetEnd(text, startPos, state.mode);
  state.test = {
    mode: state.mode,
    startPos,
    target: text.slice(startPos, end),
    typed: '',
    keystrokes: 0,
    errors: 0,
    startedAt: null,
    timer: null,
    finished: false,
    submitted: false,
  };
  input.value = '';
  modesEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
  $('#result').hidden = true;
  box.classList.remove('running');
  renderText();
  updateLive();
  updateBanner();
}

function renderText() {
  const { target } = state.test;
  const frag = document.createDocumentFragment();
  for (const ch of target) {
    const s = document.createElement('span');
    s.textContent = ch;
    frag.append(s);
  }
  textEl.replaceChildren(frag);
  textEl.style.transform = '';
  paint(0, target.length);
}

function paint(from, to) {
  const { typed, target } = state.test;
  const spans = textEl.children;
  for (let i = Math.max(0, from); i < Math.min(to, target.length); i++) {
    const cls = i < typed.length ? (typed[i] === target[i] ? 'ok' : 'bad') : i === typed.length ? 'cur' : '';
    if (spans[i].className !== cls) spans[i].className = cls;
  }
  const cur = spans[Math.min(typed.length, spans.length - 1)];
  if (cur) {
    const line = parseFloat(getComputedStyle(textEl).lineHeight);
    const shift = Math.max(0, cur.offsetTop - line);
    textEl.style.transform = `translateY(${-shift}px)`;
  }
}

function updateBanner() {
  const { chapters, arcs } = state.book;
  const t = state.test;
  const pos = t ? t.startPos + t.typed.length : resumePos();
  const ch = chapterAt(chapters, pos);
  const arc = arcs[ch.arcId];
  $('#banner-arc').textContent = `${arc.title} · Chapter ${ch.number} of ${chapters.length}`;
  $('#banner-title').textContent = ch.title;
  const p = chapterProgress(state.me.ranges, ch);
  $('#banner-bar').style.width = pct(p);
  $('#banner-pct').textContent = `${pct(p)} of chapter typed`;
}

function elapsedMs() {
  return state.test.startedAt ? performance.now() - state.test.startedAt : 0;
}

function updateLive() {
  const t = state.test;
  const m = MODES[t.mode];
  const ms = elapsedMs();
  if (m.kind === 'time') {
    $('#live-time').textContent = fmtTime(Math.max(0, m.seconds - ms / 1000));
    $('#live-time-label').textContent = 'left';
  } else {
    $('#live-time').textContent = fmtTime(ms / 1000);
    $('#live-time-label').textContent = 'time';
  }
  const stats = computeStats(t.typed, t.target, ms);
  $('#live-wpm').textContent = ms > 1000 ? Math.round(stats.wpm) : 0;
  $('#live-acc').textContent = t.keystrokes ? pct((t.keystrokes - t.errors) / t.keystrokes) : '100%';
  $('#live-progress').textContent = pct(t.typed.length / t.target.length);
}

function focusInput() {
  if ($('#view-practice').hidden) return;
  input.focus({ preventScroll: true });
}

input.addEventListener('focus', () => { box.classList.add('focused'); $('#focus-hint').hidden = true; });
input.addEventListener('blur', () => { box.classList.remove('focused'); $('#focus-hint').hidden = !!state.test?.finished; });
$('#focus-hint').addEventListener('click', focusInput);
box.addEventListener('click', focusInput);
input.addEventListener('paste', (e) => e.preventDefault());
input.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Tab'].includes(e.key)) e.preventDefault();
  if (e.key === 'Escape') newTest(state.test.startPos);
});
document.addEventListener('keydown', (e) => {
  if (document.activeElement === input || $('#view-practice').hidden || state.test?.finished) return;
  if (e.ctrlKey || e.metaKey || e.altKey || document.activeElement?.matches('input, button, a')) return;
  if (e.key.length === 1) focusInput();
});

input.addEventListener('input', () => {
  const t = state.test;
  if (t.finished) { input.value = t.typed; return; }
  let value = input.value.replace(/[\r\n\t]/g, '').replace(/ /g, ' ').slice(0, t.target.length);
  // Count each newly added character as a keystroke, and mistakes as errors.
  let common = 0;
  while (common < value.length && common < t.typed.length && value[common] === t.typed[common]) common++;
  for (let i = common; i < value.length; i++) {
    t.keystrokes++;
    if (value[i] !== t.target[i]) t.errors++;
  }
  if (!t.startedAt && value.length) startTimer();
  const before = t.typed.length;
  t.typed = value;
  if (input.value !== value) input.value = value;
  paint(Math.min(before, common) - 1, Math.max(before, value.length) + 1);
  updateLive();
  if (value.length === t.target.length) finishTest();
});

function startTimer() {
  const t = state.test;
  t.startedAt = performance.now();
  box.classList.add('running');
  t.timer = setInterval(() => {
    updateLive();
    const m = MODES[t.mode];
    if (m.kind === 'time' && elapsedMs() >= m.seconds * 1000) finishTest();
  }, 200);
}

async function finishTest() {
  const t = state.test;
  if (t.finished) return;
  t.finished = true;
  clearInterval(t.timer);
  box.classList.remove('running');
  const m = MODES[t.mode];
  const durationMs = Math.round(m.kind === 'time' ? Math.min(elapsedMs(), m.seconds * 1000) : elapsedMs());
  input.blur();
  updateLive();
  if (!t.typed.length || durationMs < 1000) { newTest(t.startPos); return; }
  try {
    const data = await api('/api/tests', {
      mode: t.mode, startPos: t.startPos, typed: t.typed, durationMs,
      keystrokes: t.keystrokes, errors: t.errors, tzOffset: new Date().getTimezoneOffset(),
    });
    t.submitted = true;
    setMe(data.me);
    showResult(data);
  } catch (err) {
    if (err.status === 401) { state.me = null; go('auth'); return; }
    t.submitted = true;
    showResult(null, err.message);
  }
}

function showResult(data, error) {
  const el = $('#result');
  el.hidden = false;
  const rewards = $('#r-rewards');
  rewards.replaceChildren();
  const add = (html, cls = '') => rewards.insertAdjacentHTML('beforeend', `<div class="reward ${cls}">${html}</div>`);

  if (error) {
    $('#r-wpm').textContent = '-';
    $('#r-acc').textContent = '-';
    $('#r-sub').textContent = '';
    add(`Could not save this test: ${esc(error)}`, 'warn');
  } else {
    const r = data.result;
    $('#r-wpm').textContent = Math.round(r.wpm);
    $('#r-acc').textContent = pct(r.accuracy);
    $('#r-sub').innerHTML = [
      `raw ${Math.round(r.rawWpm)} wpm`, `${r.chars} characters`, `${(r.durationMs / 1000).toFixed(1)}s`, MODES[state.test.mode].label,
    ].map((s) => `<span>${esc(s)}</span>`).join('');
    if (!r.counted) add(`Accuracy under ${pct(MIN_COMMIT_ACCURACY)} on the text. Your place in the book was not moved and no XP was earned. Slow down and try again.`, 'warn');
    if (r.xpGained) add(`<strong>+${r.xpGained} XP</strong>`);
    if (r.levelAfter > r.levelBefore) add(`<strong>Level up!</strong> You are now level ${r.levelAfter}, ${esc(data.me.rank)}.`);
    for (const title of r.chaptersCompleted) add(`Chapter complete: <strong>${esc(title)}</strong>`);
    for (const b of data.newBadges) {
      add(`New badge: <strong>${esc(b.name)}</strong> <span class="muted">${esc(b.desc)}</span>`);
      toast(b);
    }
  }
  updateBanner();
  $('#r-next').focus();
}

$('#r-next').addEventListener('click', () => { newTest(); focusInput(); });
$('#r-retry').addEventListener('click', () => { newTest(state.test.startPos); focusInput(); });

function toast(b) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="dot"></span><div><strong>${esc(b.name)}</strong><small>${esc(b.desc)}</small></div>`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- chapters ----------

function renderChapters() {
  const { arcs, chapters } = state.book;
  const { ranges } = state.me;
  const here = chapterAt(chapters, resumePos()).id;
  const earned = new Set(state.me.badges.filter((b) => b.earnedAt).map((b) => b.id));
  const done = chapters.filter((c) => chapterProgress(ranges, c) >= 1).length;
  $('#book-summary').textContent = `${done} of ${chapters.length} chapters complete. Pick any chapter to type it, or continue where you left off.`;

  $('#arcs').innerHTML = arcs.map((arc) => `
    <div class="arc">
      <div class="arc-head">
        <h2>${esc(arc.title)}</h2>
        <span class="badge-name ${earned.has(`arc_${arc.id}`) ? 'earned' : ''}">${esc(arc.badge)}</span>
      </div>
      ${arc.chapterIds.map((id) => {
        const ch = chapters[id];
        const p = chapterProgress(ranges, ch);
        return `
          <div class="chapter ${p >= 1 ? 'done' : ''} ${id === here ? 'current' : ''}">
            <span class="num">${String(ch.number).padStart(2, '0')}</span>
            <span>${esc(ch.title)}${id === here ? '<span class="here">you are here</span>' : ''}</span>
            <div class="bar"><div style="width:${pct(p)}"></div></div>
            <span class="pct">${pct(p)}</span>
            <button data-start="${ch.start}">${id === here ? 'Continue' : p >= 1 ? 'Retype' : 'Type'}</button>
          </div>`;
      }).join('')}
    </div>`).join('');
}

$('#arcs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-start]');
  if (!btn) return;
  const start = Number(btn.dataset.start);
  const here = chapterAt(state.book.chapters, resumePos());
  // "Continue" resumes mid-chapter; any other chapter starts at its beginning.
  const pos = start === here.start ? resumePos() : start;
  state.test = null;
  state.startPos = pos;
  go('practice');
});

// ---------- profile ----------

async function renderProfile() {
  const me = state.me;
  $('#p-name').textContent = me.username;
  $('#p-rank').textContent = `Level ${me.level} · ${me.rank}`;
  $('#p-xpbar').style.width = pct((me.xp - me.levelStartXp) / (me.nextLevelXp - me.levelStartXp));
  $('#p-xptext').textContent = `${me.xp} XP · ${me.nextLevelXp - me.xp} to level ${me.level + 1}`;
  const done = state.book.chapters.filter((c) => chapterProgress(me.ranges, c) >= 1).length;
  const typedChars = me.ranges.reduce((n, [s, e]) => n + e - s, 0);
  const stats = [
    [Math.round(me.bestWpm), 'best WPM'],
    [me.streak, 'day streak'],
    [me.testsCount, 'tests taken'],
    [`${done}/${state.book.chapters.length}`, 'chapters complete'],
    [pct(typedChars / state.book.text.length), 'of the book typed'],
    [`${me.badges.filter((b) => b.earnedAt).length}/${me.badges.length}`, 'badges'],
  ];
  $('#p-stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><span>${esc(v)}</span><small>${esc(l)}</small></div>`).join('');
  $('#p-badges').innerHTML = me.badges.map((b) => `
    <div class="badge ${b.earnedAt ? 'earned' : 'locked'}" title="${b.earnedAt ? `Earned ${new Date(b.earnedAt).toLocaleDateString()}` : 'Locked'}">
      <span class="dot"></span>
      <div><strong>${esc(b.name)}</strong><small>${esc(b.desc)}</small></div>
    </div>`).join('');

  const table = $('#p-history');
  table.innerHTML = '<tr><td class="muted">Loading...</td></tr>';
  try {
    const { tests, bestByMode } = await api('/api/history');
    const { chapters } = state.book;
    const best = Object.entries(MODES).map(([id, m]) => `${m.label}: ${bestByMode[id] ? Math.round(bestByMode[id]) : '-'}`).join(' · ');
    table.innerHTML = `
      <caption class="muted" style="text-align:left;padding-bottom:.5rem">Best WPM by mode: ${esc(best)}</caption>
      <tr><th>When</th><th>Mode</th><th>WPM</th><th>Accuracy</th><th>Chapter</th><th>XP</th></tr>
      ${tests.length ? tests.map((t) => `
        <tr>
          <td>${esc(new Date(t.created_at).toLocaleString())}</td>
          <td>${esc(MODES[t.mode]?.label ?? t.mode)}</td>
          <td class="num">${Math.round(t.wpm)}</td>
          <td class="num">${pct(t.accuracy)}</td>
          <td>${esc(chapterAt(chapters, t.start_pos).title)}</td>
          <td class="num">${t.committed ? `+${t.xp}` : '<span class="muted">not saved</span>'}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted">No tests yet. Go type your first passage.</td></tr>'}`;
  } catch (err) {
    table.innerHTML = `<tr><td class="error">${esc(err.message)}</td></tr>`;
  }
}

// ---------- leaderboard ----------

async function renderLeaderboard() {
  const table = $('#leaders');
  table.innerHTML = '<tr><td class="muted">Loading...</td></tr>';
  try {
    const { leaders } = await api('/api/leaderboard');
    table.innerHTML = `
      <tr><th>#</th><th>Name</th><th>Level</th><th>Rank</th><th>XP</th><th>Best WPM</th><th>Chapters</th></tr>
      ${leaders.map((l, i) => `
        <tr class="${l.username === state.me.username ? 'me' : ''}">
          <td class="num">${i + 1}</td><td>${esc(l.username)}</td><td class="num">${l.level}</td><td>${esc(l.rank)}</td>
          <td class="num">${l.xp}</td><td class="num">${Math.round(l.bestWpm)}</td><td class="num">${l.chapters}</td>
        </tr>`).join('')}`;
  } catch (err) {
    table.innerHTML = `<tr><td class="error">${esc(err.message)}</td></tr>`;
  }
}

// ---------- boot ----------

async function boot() {
  try {
    state.book = await api('/api/book');
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="auth-card"><h1>Server unavailable</h1><p class="error">Could not reach the API (${esc(err.message)}). Type Master needs its Node server running; see the README.</p></div>`;
    return;
  }
  try {
    const { me } = await api('/api/me');
    setMe(me);
  } catch { /* not logged in */ }
  window.addEventListener('hashchange', route);
  route();
}

boot();
