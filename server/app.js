// The API as a single Web-standard handler: (Request) => Promise<Response>.
// Used by the Vercel function in api/[route].js and by the local server in server/index.js.
import { openDb } from './db.js';
import { COOKIE, hashPassword, verifyPassword, createSession, destroySession, userForToken, parseCookies } from './auth.js';
import {
  BADGES, CHAPTER_BONUS_XP, ARC_BONUS_XP, BOOK_BONUS_XP,
  levelForXp, xpForLevel, rankForLevel, testXp, qualifyingBadges,
} from './rewards.js';
import { book } from '../content/book.js';
import {
  MODES, PAGE_CHARS, MIN_COMMIT_ACCURACY,
  isWordStart, targetEnd, commitLength, computeStats, addRange, chapterProgress,
} from '../public/shared/engine.js';

const MAX_BODY = 256 * 1024;
const MAX_WPM = 300;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BOOK_PAYLOAD = JSON.stringify({ arcs: book.arcs, chapters: book.chapters, text: book.text, pageChars: PAGE_CHARS });

function json(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function localDay(tzOffsetMinutes, now = Date.now()) {
  return new Date(now - tzOffsetMinutes * 60000).toISOString().slice(0, 10);
}

function previousDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function completedChapterIds(ranges) {
  return book.chapters.filter((ch) => chapterProgress(ranges, ch) >= 1).map((ch) => ch.id);
}

export function createHandler({ url, authToken } = {}) {
  let db;
  const getDb = () => {
    if (!url) throw new HttpError(500, 'Database not configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN');
    return (db ??= openDb({ url, authToken }));
  };

  async function buildMe(user) {
    const level = levelForXp(user.xp);
    const [badgeRows, count] = await Promise.all([
      getDb().all('SELECT badge_id, earned_at FROM badges WHERE user_id = ?', user.id),
      getDb().get('SELECT COUNT(*) AS n FROM tests WHERE user_id = ?', user.id),
    ]);
    const earned = new Map(badgeRows.map((b) => [b.badge_id, b.earned_at]));
    return {
      username: user.username,
      xp: user.xp,
      level,
      rank: rankForLevel(level),
      levelStartXp: xpForLevel(level),
      nextLevelXp: xpForLevel(level + 1),
      streak: user.streak,
      lastDay: user.last_day,
      bestWpm: user.best_wpm,
      position: user.position,
      ranges: JSON.parse(user.ranges),
      testsCount: count.n,
      badges: BADGES.map((b) => ({ ...b, earnedAt: earned.get(b.id) ?? null })),
    };
  }

  async function requireUser(request) {
    const user = await userForToken(getDb(), parseCookies(request.headers.get('cookie') ?? '')[COOKIE]);
    if (!user) throw new HttpError(401, 'Please log in');
    return user;
  }

  function credentials(body) {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3-20 letters, numbers or underscores');
    if (password.length < 6 || password.length > 200) throw new HttpError(400, 'Password must be at least 6 characters');
    return { username, password };
  }

  async function submitTest(user, body) {
    const db = getDb();
    const { mode, startPos, typed, durationMs, keystrokes, errors } = body;
    const tzOffset = Number.isInteger(body.tzOffset) && Math.abs(body.tzOffset) <= 840 ? body.tzOffset : 0;
    const m = MODES[mode];
    if (!m) throw new HttpError(400, 'Unknown mode');
    if (!isWordStart(book.text, startPos)) throw new HttpError(400, 'Invalid start position');
    if (typeof typed !== 'string' || typed.length === 0) throw new HttpError(400, 'Nothing typed');

    const target = book.text.slice(startPos, targetEnd(book.text, startPos, mode));
    if (typed.length > target.length) throw new HttpError(400, 'Typed text longer than passage');
    const maxMs = m.kind === 'time' ? m.seconds * 1000 + 3000 : 3 * 3600 * 1000;
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > maxMs) throw new HttpError(400, 'Invalid duration');
    if (!Number.isInteger(keystrokes) || !Number.isInteger(errors) || keystrokes < 1 || errors < 0 || errors > keystrokes) {
      throw new HttpError(400, 'Invalid keystroke counts');
    }

    const stats = computeStats(typed, target, durationMs);
    if (stats.wpm > MAX_WPM) throw new HttpError(400, 'That speed is not humanly plausible');
    const accuracy = Math.min((keystrokes - errors) / keystrokes, stats.textAccuracy);
    const completed = typed.length === target.length || (m.kind === 'time' && durationMs >= m.seconds * 1000 - 1500);
    const counts = stats.textAccuracy >= MIN_COMMIT_ACCURACY;

    let ranges = JSON.parse(user.ranges);
    let position = user.position;
    let endPos = startPos;
    let xpGained = 0;
    const doneBefore = new Set(completedChapterIds(ranges));
    const newChapters = [];
    const arcsDone = new Set();
    let bookDone = false;

    if (counts) {
      endPos = startPos + commitLength(typed, target);
      if (book.text[endPos] === ' ') endPos++;
      ranges = addRange(ranges, startPos, endPos);
      position = endPos;
      xpGained = testXp(stats.correct, accuracy);

      const doneNow = new Set(completedChapterIds(ranges));
      for (const id of doneNow) if (!doneBefore.has(id)) newChapters.push(book.chapters[id]);
      xpGained += newChapters.length * CHAPTER_BONUS_XP;
      for (const arc of book.arcs) {
        if (arc.chapterIds.every((id) => doneNow.has(id))) {
          arcsDone.add(arc.id);
          if (!arc.chapterIds.every((id) => doneBefore.has(id))) xpGained += ARC_BONUS_XP;
        }
      }
      bookDone = doneNow.size === book.chapters.length;
      if (bookDone && doneBefore.size !== book.chapters.length) xpGained += BOOK_BONUS_XP;
    }

    const today = localDay(tzOffset);
    let streak = user.streak;
    if (user.last_day !== today) streak = user.last_day === previousDay(today) ? streak + 1 : 1;

    const now = Date.now();
    const levelBefore = levelForXp(user.xp);
    const newBadges = [];
    const statements = [
      [
        'UPDATE users SET xp = xp + ?, position = ?, ranges = ?, streak = ?, last_day = ?, best_wpm = ? WHERE id = ?',
        xpGained, position, JSON.stringify(ranges), streak, today, counts ? Math.max(user.best_wpm, stats.wpm) : user.best_wpm, user.id,
      ],
      [
        'INSERT INTO tests (user_id, mode, start_pos, end_pos, wpm, raw_wpm, accuracy, chars, duration_ms, xp, committed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        user.id, mode, startPos, endPos, stats.wpm, stats.rawWpm, accuracy, typed.length, Math.round(durationMs), xpGained, counts ? 1 : 0, now,
      ],
    ];

    if (counts) {
      const [count, ownedRows] = await Promise.all([
        db.get('SELECT COUNT(*) AS n FROM tests WHERE user_id = ? AND committed = 1', user.id),
        db.all('SELECT badge_id FROM badges WHERE user_id = ?', user.id),
      ]);
      const owned = new Set(ownedRows.map((b) => b.badge_id));
      const ids = qualifyingBadges({
        wpm: stats.wpm, accuracy, chars: typed.length, mode, completed, streak, testsCount: count.n + 1,
        chaptersDone: doneBefore.size + newChapters.length, arcsDone, bookDone,
      });
      for (const id of ids) {
        if (owned.has(id)) continue;
        statements.push(['INSERT OR IGNORE INTO badges (user_id, badge_id, earned_at) VALUES (?, ?, ?)', user.id, id, now]);
        newBadges.push(BADGES.find((b) => b.id === id));
      }
    }

    await db.batch(statements);
    const updated = await db.get('SELECT * FROM users WHERE id = ?', user.id);
    return {
      result: {
        wpm: stats.wpm,
        rawWpm: stats.rawWpm,
        accuracy,
        correct: stats.correct,
        chars: typed.length,
        durationMs,
        completed,
        counted: counts,
        xpGained,
        chaptersCompleted: newChapters.map((c) => c.title),
        levelBefore,
        levelAfter: levelForXp(updated.xp),
      },
      newBadges,
      me: await buildMe(updated),
    };
  }

  const routes = {
    'GET /api/book': () => json(200, BOOK_PAYLOAD, { 'Cache-Control': 'public, max-age=300' }),

    'POST /api/register': async (request) => {
      const db = getDb();
      const { username, password } = credentials(await readJson(request));
      if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is taken');
      const { salt, hash } = hashPassword(password);
      let userId;
      try {
        const res = await db.run('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)', username, hash, salt, Date.now());
        userId = Number(res.lastInsertRowid);
      } catch (err) {
        if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'That username is taken');
        throw err;
      }
      const { token, maxAge } = await createSession(db, userId);
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      return json(201, { me: await buildMe(user) }, { 'Set-Cookie': sessionCookie(request, token, maxAge) });
    },

    'POST /api/login': async (request) => {
      const db = getDb();
      const { username, password } = credentials(await readJson(request));
      const user = await db.get('SELECT * FROM users WHERE username = ?', username);
      if (!user || !verifyPassword(password, user.salt, user.pass_hash)) throw new HttpError(401, 'Wrong username or password');
      const { token, maxAge } = await createSession(db, user.id);
      return json(200, { me: await buildMe(user) }, { 'Set-Cookie': sessionCookie(request, token, maxAge) });
    },

    'POST /api/logout': async (request) => {
      await destroySession(getDb(), parseCookies(request.headers.get('cookie') ?? '')[COOKIE]);
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) });
    },

    'GET /api/me': async (request) => json(200, { me: await buildMe(await requireUser(request)) }),

    'POST /api/tests': async (request) => {
      const user = await requireUser(request);
      return json(200, await submitTest(user, await readJson(request)));
    },

    'GET /api/history': async (request) => {
      const db = getDb();
      const user = await requireUser(request);
      const [tests, best] = await Promise.all([
        db.all('SELECT mode, start_pos, end_pos, wpm, raw_wpm, accuracy, chars, duration_ms, xp, committed, created_at FROM tests WHERE user_id = ? ORDER BY id DESC LIMIT 30', user.id),
        db.all('SELECT mode, MAX(wpm) AS wpm FROM tests WHERE user_id = ? AND committed = 1 GROUP BY mode', user.id),
      ]);
      return json(200, { tests, bestByMode: Object.fromEntries(best.map((b) => [b.mode, b.wpm])) });
    },

    'GET /api/leaderboard': async () => {
      const rows = await getDb().all('SELECT username, xp, best_wpm, ranges FROM users ORDER BY xp DESC, id ASC LIMIT 25');
      return json(200, {
        leaders: rows.map((r) => {
          const level = levelForXp(r.xp);
          return {
            username: r.username, xp: r.xp, level, rank: rankForLevel(level), bestWpm: r.best_wpm,
            chapters: completedChapterIds(JSON.parse(r.ranges)).length,
          };
        }),
      });
    },
  };

  async function handle(request) {
    const { pathname } = new URL(request.url);
    try {
      const route = routes[`${request.method} ${pathname.replace(/\/+$/, '')}`];
      if (!route) throw new HttpError(404, 'Not found');
      return await route(request);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Something went wrong' });
    }
  }

  handle.close = () => db?.close();
  return handle;
}
