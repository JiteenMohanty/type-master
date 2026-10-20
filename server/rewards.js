import { book } from '../content/book.js';

export const CHAPTER_BONUS_XP = 25;
export const ARC_BONUS_XP = 150;
export const BOOK_BONUS_XP = 1000;

// Cumulative XP needed to reach level L is 50 * L * (L - 1): 0, 100, 300, 600, 1000, ...
export function xpForLevel(level) {
  return 50 * level * (level - 1);
}

export function levelForXp(xp) {
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2));
}

const RANKS = [
  [1, 'Vanara Cub'],
  [3, 'Forest Wanderer'],
  [5, 'Kishkindha Scout'],
  [8, "Sugriva's Minister"],
  [12, "Rama's Messenger"],
  [16, 'Ocean Leaper'],
  [20, 'Burner of Lanka'],
  [25, 'Bearer of the Mountain'],
  [30, 'Chiranjeevi'],
];

export function rankForLevel(level) {
  let rank = RANKS[0][1];
  for (const [min, name] of RANKS) if (level >= min) rank = name;
  return rank;
}

// Words typed correctly, weighted by accuracy squared so sloppy typing earns little.
export function testXp(correctChars, accuracy) {
  return Math.round((correctChars / 5) * accuracy * accuracy);
}

export const BADGES = [
  { id: 'first_test', icon: '🌱', name: 'First Steps', desc: 'Finish your first test' },
  { id: 'first_chapter', icon: '📜', name: 'First Chapter', desc: 'Complete any chapter' },
  { id: 'wpm_30', icon: '🐾', name: 'Steady Steps', desc: 'Reach 30 WPM' },
  { id: 'wpm_50', icon: '🍃', name: 'Swift as the Wind', desc: 'Reach 50 WPM' },
  { id: 'wpm_70', icon: '⛰️', name: 'Leap from Mahendra', desc: 'Reach 70 WPM' },
  { id: 'wpm_100', icon: '🦅', name: 'Faster than Garuda', desc: 'Reach 100 WPM' },
  { id: 'perfect', icon: '💎', name: 'Flawless Speech', desc: '100% accuracy over at least 200 characters' },
  { id: 'marathon', icon: '⏳', name: 'Unwavering', desc: 'Complete a 5 minute test' },
  { id: 'two_pages', icon: '📖', name: 'Scribe of the Epic', desc: 'Complete a 2 page test' },
  { id: 'streak_3', icon: '🔥', name: 'Devoted', desc: 'Practise 3 days in a row' },
  { id: 'streak_7', icon: '🪔', name: 'Tapasya', desc: 'Practise 7 days in a row' },
  { id: 'streak_30', icon: '🕉️', name: 'Unbroken Vow', desc: 'Practise 30 days in a row' },
  { id: 'tests_10', icon: '🎓', name: 'Disciple', desc: 'Finish 10 tests' },
  { id: 'tests_50', icon: '📚', name: 'Scholar of Nine Grammars', desc: 'Finish 50 tests' },
  { id: 'tests_100', icon: '☀️', name: 'Student of the Sun', desc: 'Finish 100 tests' },
  ...book.arcs.map((arc) => ({
    id: `arc_${arc.id}`,
    icon: '🏵️',
    name: arc.badge,
    desc: `Complete the arc "${arc.title}"`,
  })),
  { id: 'book', icon: '🚩', name: 'Chiranjeevi', desc: 'Type the entire life story of Hanuman' },
];

// ctx: { wpm, accuracy, chars, mode, completed, streak, testsCount, chaptersDone, arcsDone: Set, bookDone }
export function qualifyingBadges(ctx) {
  const ids = ['first_test'];
  if (ctx.chaptersDone > 0) ids.push('first_chapter');
  for (const n of [30, 50, 70, 100]) if (ctx.wpm >= n) ids.push(`wpm_${n}`);
  if (ctx.accuracy >= 1 && ctx.chars >= 200) ids.push('perfect');
  if (ctx.completed && ctx.mode === 't300') ids.push('marathon');
  if (ctx.completed && ctx.mode === 'p2') ids.push('two_pages');
  for (const n of [3, 7, 30]) if (ctx.streak >= n) ids.push(`streak_${n}`);
  for (const n of [10, 50, 100]) if (ctx.testsCount >= n) ids.push(`tests_${n}`);
  for (const arcId of ctx.arcsDone) ids.push(`arc_${arcId}`);
  if (ctx.bookDone) ids.push('book');
  return ids;
}
