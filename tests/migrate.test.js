import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, BOOK_VERSION } from '../content/book.js';
import { BOOK_V1 } from '../content/legacy.js';
import { openDb } from '../server/db.js';
import { offsetMapper, upgradeProgress } from '../server/migrate.js';
import { chapterProgress, isWordStart } from '../public/shared/engine.js';

const chapter = (title) => book.chapters.find((c) => c.title === title);
const v1 = (title) => BOOK_V1.find(([t]) => t === title);

test('finished v1 chapters stay finished, and new chapters start untyped', () => {
  const m = offsetMapper();
  const [, s1] = v1('The Apsara and the Curse');
  const [, , e2] = v1('The Gift of the Wind');
  const ranges = m.ranges([[s1, e2 + 1]]);
  assert.equal(chapterProgress(ranges, chapter('The Apsara and the Curse')), 1);
  assert.equal(chapterProgress(ranges, chapter('The Gift of the Wind')), 1);
  assert.equal(chapterProgress(ranges, chapter('The Eleventh Rudra')), 0);

  const [, s, e] = v1('Ahiravana and the Five Faces');
  const split = m.ranges([[s, e]]);
  assert.equal(chapterProgress(split, chapter('Ahiravana of the Underworld')), 1);
  assert.equal(chapterProgress(split, chapter('The Five Faces')), 1);
});

test('positions land on a word start in the same chapter', () => {
  const m = offsetMapper();
  for (const [title, s, e] of BOOK_V1) {
    const p = m.wordStart(Math.floor((s + e) / 2));
    assert.ok(isWordStart(book.text, p));
    const holder = book.chapters.find((c) => p >= c.start && p < c.end);
    assert.ok(holder, title);
  }
  assert.equal(m.wordStart(BOOK_V1.at(-1)[2]), book.text.length);
});

test('upgradeProgress rewrites v1 users once', async () => {
  const db = openDb({ url: ':memory:' });
  await db.init();
  const [, s, e] = v1('The Boy Who Chased the Sun');
  await db.run("INSERT INTO users (id, username, pass_hash, salt, created_at, position, ranges) VALUES (1, 'old', 'x', 'y', 0, ?, ?)", e + 1, JSON.stringify([[0, e + 1]]));
  await db.run("INSERT INTO tests (user_id, mode, start_pos, end_pos, wpm, raw_wpm, accuracy, chars, duration_ms, xp, committed, created_at) VALUES (1, 't60', ?, ?, 50, 50, 1, 10, 60000, 10, 1, 0)", s, e);

  await upgradeProgress(db.client);
  await upgradeProgress(db.client);

  const u = await db.get('SELECT * FROM users WHERE id = 1');
  assert.equal(u.book_version, BOOK_VERSION);
  assert.equal(u.position, chapter("Indra's Thunderbolt").start);
  const ranges = JSON.parse(u.ranges);
  for (const t of ['The Apsara and the Curse', 'The Gift of the Wind', 'The Boy Who Chased the Sun']) {
    assert.equal(chapterProgress(ranges, chapter(t)), 1, t);
  }
  const t = await db.get('SELECT start_pos, end_pos FROM tests WHERE user_id = 1');
  assert.equal(t.start_pos, chapter('The Boy Who Chased the Sun').start);
  assert.equal(t.end_pos, chapter('The Boy Who Chased the Sun').end);
  db.close();
});
