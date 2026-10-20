import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from '../content/book.js';
import { MODES, targetEnd, commitLength, computeStats, addRange, coveredIn, isWordStart, chapterAt } from '../shared/engine.js';
import { levelForXp, xpForLevel, testXp } from '../server/rewards.js';

test('book is plain typable ASCII with consistent chapter offsets', () => {
  assert.match(book.text, /^[\x20-\x7e]+$/);
  assert.equal(book.chapters.length, 34);
  for (const ch of book.chapters) {
    assert.ok(isWordStart(book.text, ch.start), `chapter ${ch.number} starts on a word`);
    assert.ok(ch.end === book.text.length || book.text[ch.end] === ' ');
  }
  assert.equal(book.chapters.at(-1).end, book.text.length);
});

test('targetEnd stops on a word boundary within the mode budget', () => {
  for (const mode of Object.keys(MODES)) {
    const end = targetEnd(book.text, 0, mode);
    assert.ok(end > 0 && end <= book.text.length);
    assert.equal(book.text[end], ' ');
  }
  assert.equal(targetEnd(book.text, book.chapters.at(-1).start, 'p2'), book.text.length);
});

test('commitLength counts whole words only', () => {
  const target = 'the son of the wind';
  assert.equal(commitLength('the so', target), 4);
  assert.equal(commitLength('the son', target), 7);
  assert.equal(commitLength('the son ', target), 8);
  assert.equal(commitLength(target, target), target.length);
  assert.equal(commitLength('th', target), 0);
});

test('computeStats', () => {
  const s = computeStats('abcdx', 'abcde', 60000);
  assert.equal(s.correct, 4);
  assert.equal(s.wpm, 0.8);
  assert.equal(s.rawWpm, 1);
  assert.equal(s.textAccuracy, 0.8);
});

test('ranges merge and measure coverage', () => {
  let r = addRange([], 10, 20);
  r = addRange(r, 0, 5);
  r = addRange(r, 5, 10);
  assert.deepEqual(r, [[0, 20]]);
  r = addRange(r, 30, 40);
  assert.equal(coveredIn(r, 15, 35), 10);
});

test('chapterAt maps positions to chapters', () => {
  const [a, b] = book.chapters;
  assert.equal(chapterAt(book.chapters, 0).id, a.id);
  assert.equal(chapterAt(book.chapters, a.end).id, a.id);
  assert.equal(chapterAt(book.chapters, b.start).id, b.id);
});

test('levels', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);
  assert.equal(levelForXp(xpForLevel(10)), 10);
  assert.equal(levelForXp(xpForLevel(10) - 1), 9);
  assert.equal(testXp(500, 1), 100);
  assert.equal(testXp(500, 0.5), 25);
});
