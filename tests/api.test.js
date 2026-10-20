import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { book } from '../content/book.js';
import { targetEnd } from '../shared/engine.js';

let server;
let base;

before(async () => {
  server = createApp({ dbPath: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

function client() {
  let cookie = '';
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

const passage = (start, mode) => book.text.slice(start, targetEnd(book.text, start, mode));

test('auth flow', async () => {
  const call = client();
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/register', { username: 'ab', password: 'secret1' })).status, 400);
  const reg = await call('/api/register', { username: 'anjaneya', password: 'secret1' });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.me.level, 1);
  assert.equal((await call('/api/register', { username: 'Anjaneya', password: 'secret1' })).status, 409);
  assert.equal((await call('/api/me')).data.me.username, 'anjaneya');
  await call('/api/logout', {});
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/login', { username: 'anjaneya', password: 'wrong12' })).status, 401);
  assert.equal((await call('/api/login', { username: 'anjaneya', password: 'secret1' })).status, 200);
});

test('timed test saves progress by whole words and awards XP and badges', async () => {
  const call = client();
  await call('/api/register', { username: 'maruti', password: 'secret1' });
  const target = passage(0, 't60');
  const typed = target.slice(0, 203); // ends mid-word
  const { status, data } = await call('/api/tests', { mode: 't60', startPos: 0, typed, durationMs: 60000, keystrokes: typed.length, errors: 0 });
  assert.equal(status, 200);
  assert.ok(data.result.counted);
  assert.ok(data.result.xpGained > 0);
  const pos = data.me.position;
  assert.ok(pos <= 204 && pos > 150);
  assert.equal(book.text[pos - 1], ' ');
  const ids = data.newBadges.map((b) => b.id);
  assert.ok(ids.includes('first_test'));
  assert.ok(ids.includes('perfect'));
  assert.ok(ids.includes('marathon') === false);
});

test('sloppy test does not move progress', async () => {
  const call = client();
  await call('/api/register', { username: 'pavan', password: 'secret1' });
  const typed = 'x'.repeat(100);
  const { data } = await call('/api/tests', { mode: 't60', startPos: 0, typed, durationMs: 60000, keystrokes: 100, errors: 100 });
  assert.equal(data.result.counted, false);
  assert.equal(data.result.xpGained, 0);
  assert.equal(data.me.position, 0);
  assert.equal(data.newBadges.length, 0);
});

test('page tests complete chapters and reject invalid submissions', async () => {
  const call = client();
  await call('/api/register', { username: 'kesari', password: 'secret1' });
  const target = passage(0, 'p2');
  assert.ok(target.length > book.chapters[0].end);
  const { data } = await call('/api/tests', { mode: 'p2', startPos: 0, typed: target, durationMs: 600000, keystrokes: target.length, errors: 3 });
  assert.deepEqual(data.result.chaptersCompleted, [book.chapters[0].title]);
  const ids = data.newBadges.map((b) => b.id);
  assert.ok(ids.includes('first_chapter') && ids.includes('two_pages'));
  assert.equal(data.me.position, target.length + 1);

  const bad = (body) => call('/api/tests', { mode: 'p1', startPos: 0, typed: 'The', durationMs: 5000, keystrokes: 3, errors: 0, ...body });
  assert.equal((await bad({ startPos: 3 })).status, 400);
  assert.equal((await bad({ mode: 'zzz' })).status, 400);
  assert.equal((await bad({ durationMs: 10 })).status, 400);
  assert.equal((await bad({ typed: passage(0, 'p1'), durationMs: 2000 })).status, 400); // implausible speed
  assert.equal((await bad({ mode: 't60', durationMs: 120000 })).status, 400);

  const lb = await call('/api/leaderboard');
  assert.equal(lb.data.leaders.find((l) => l.username === 'kesari').chapters, 1);
  const hist = await call('/api/history');
  assert.equal(hist.data.tests.length, 1);
});
