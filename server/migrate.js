// Carries saved progress forward when the book's text changes.
// Progress is stored as character offsets, so each offset is moved to the same relative place
// in the chapter that now holds that text.
import { book, BOOK_VERSION } from '../content/book.js';
import { BOOK_V1, RENAMED_V1 } from '../content/legacy.js';
import { addRange, isWordStart } from '../public/shared/engine.js';

export function offsetMapper(oldChapters = BOOK_V1, renamed = RENAMED_V1, chapters = book.chapters) {
  const byTitle = new Map(chapters.map((ch) => [ch.title, ch]));
  const spans = oldChapters.map(([title, start, end]) => {
    const titles = renamed[title] ?? [title];
    const first = byTitle.get(titles[0]);
    const last = byTitle.get(titles.at(-1));
    if (!first || !last) throw new Error(`No chapter for "${title}" in the current book`);
    return { start, end, newStart: first.start, newEnd: last.end };
  });

  const spanAt = (pos) => {
    let i = 0;
    while (i < spans.length - 1 && pos >= spans[i + 1].start) i++;
    return spans[i];
  };
  const map = (pos, span = spanAt(pos)) => {
    const f = Math.min(1, Math.max(0, (pos - span.start) / (span.end - span.start)));
    return Math.round(span.newStart + f * (span.newEnd - span.newStart));
  };

  return {
    offset: map,
    wordStart(pos) {
      let p = map(pos);
      if (p >= book.text.length) return book.text.length;
      while (p > 0 && !isWordStart(book.text, p)) p--;
      return p;
    },
    // Split at old chapter edges so text added between chapters is never marked as typed.
    ranges(ranges) {
      let out = [];
      for (const [s, e] of ranges) {
        for (const span of spans) {
          const lo = Math.max(s, span.start);
          const hi = Math.min(e, span.end);
          if (hi > lo) out = addRange(out, map(lo, span), map(hi, span));
        }
      }
      return out;
    },
  };
}

// Runs on a raw libSQL client before the API serves requests. Safe to run concurrently.
export async function upgradeProgress(client) {
  try {
    await client.execute('ALTER TABLE users ADD COLUMN book_version INTEGER NOT NULL DEFAULT 1');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  const { rows: users } = await client.execute({
    sql: 'SELECT id, position, ranges, book_version FROM users WHERE book_version < ?',
    args: [BOOK_VERSION],
  });
  if (!users.length) return;
  const mapper = offsetMapper();
  for (const u of users) {
    const { rows: tests } = await client.execute({ sql: 'SELECT id, start_pos, end_pos FROM tests WHERE user_id = ?', args: [u.id] });
    await client.batch([
      {
        sql: 'UPDATE users SET position = ?, ranges = ?, book_version = ? WHERE id = ? AND book_version = ?',
        args: [mapper.wordStart(u.position), JSON.stringify(mapper.ranges(JSON.parse(u.ranges))), BOOK_VERSION, u.id, u.book_version],
      },
      ...tests.map((t) => ({
        sql: 'UPDATE tests SET start_pos = ?, end_pos = ? WHERE id = ? AND start_pos = ? AND end_pos = ?',
        args: [mapper.wordStart(t.start_pos), mapper.offset(t.end_pos), t.id, t.start_pos, t.end_pos],
      })),
    ], 'write');
  }
}
