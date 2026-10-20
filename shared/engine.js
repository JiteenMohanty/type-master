// Shared by server and browser. Pure functions only.

export const PAGE_CHARS = 1500; // ~250 words, roughly one printed book page
const TIME_CHARS_PER_SECOND = 30; // enough text for ~360 WPM
export const MIN_COMMIT_ACCURACY = 0.75;

export const MODES = {
  t60: { label: '1 min', kind: 'time', seconds: 60 },
  t180: { label: '3 min', kind: 'time', seconds: 180 },
  t300: { label: '5 min', kind: 'time', seconds: 300 },
  p1: { label: '1 page', kind: 'page', pages: 1 },
  p2: { label: '2 pages', kind: 'page', pages: 2 },
};

export function isWordStart(text, pos) {
  return Number.isInteger(pos) && pos >= 0 && pos < text.length && (pos === 0 || text[pos - 1] === ' ');
}

// End offset (exclusive) of the passage served for a test starting at `start`.
export function targetEnd(text, start, modeId) {
  const mode = MODES[modeId];
  const want = mode.kind === 'time' ? mode.seconds * TIME_CHARS_PER_SECOND : mode.pages * PAGE_CHARS;
  let end = Math.min(text.length, start + want);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > start) end = sp;
  }
  return end;
}

// How many typed characters count towards book progress: only whole words.
export function commitLength(typed, target) {
  const len = typed.length;
  if (len === target.length || target[len] === ' ') return len;
  return typed.lastIndexOf(' ') + 1;
}

export function countCorrect(typed, target) {
  let n = 0;
  for (let i = 0; i < typed.length; i++) if (typed[i] === target[i]) n++;
  return n;
}

export function computeStats(typed, target, durationMs) {
  const minutes = Math.max(durationMs, 1) / 60000;
  const correct = countCorrect(typed, target);
  return {
    correct,
    typed: typed.length,
    wpm: correct / 5 / minutes,
    rawWpm: typed.length / 5 / minutes,
    textAccuracy: typed.length ? correct / typed.length : 0,
  };
}

// --- coverage ranges: sorted, merged, half-open [start, end) intervals ---

export function addRange(ranges, start, end) {
  if (end <= start) return ranges.map((r) => r.slice());
  const all = [...ranges.map((r) => r.slice()), [start, end]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

export function coveredIn(ranges, start, end) {
  let n = 0;
  for (const [s, e] of ranges) {
    const lo = Math.max(s, start);
    const hi = Math.min(e, end);
    if (hi > lo) n += hi - lo;
  }
  return n;
}

export function chapterProgress(ranges, chapter) {
  return coveredIn(ranges, chapter.start, chapter.end) / (chapter.end - chapter.start);
}

export function chapterAt(chapters, pos) {
  for (const ch of chapters) if (pos < ch.end + 1) return ch;
  return chapters[chapters.length - 1];
}
