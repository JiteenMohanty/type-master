import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
} from '../shared/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIRS = { '/shared/': join(ROOT, 'shared'), '/': join(ROOT, 'public') };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
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

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
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

export function createApp({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);

  function buildMe(user) {
    const level = levelForXp(user.xp);
    const earned = new Map(db.prepare('SELECT badge_id, earned_at FROM badges WHERE user_id = ?').all(user.id).map((b) => [b.badge_id, b.earned_at]));
    const testsCount = db.prepare('SELECT COUNT(*) AS n FROM tests WHERE user_id = ?').get(user.id).n;
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
      testsCount,
      badges: BADGES.map((b) => ({ ...b, earnedAt: earned.get(b.id) ?? null })),
    };
  }

  function requireUser(req) {
    const user = userForToken(db, parseCookies(req.headers.cookie)[COOKIE]);
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

  function submitTest(user, body) {
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

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET xp = xp + ?, position = ?, ranges = ?, streak = ?, last_day = ?, best_wpm = ? WHERE id = ?').run(
        xpGained, position, JSON.stringify(ranges), streak, today, counts ? Math.max(user.best_wpm, stats.wpm) : user.best_wpm, user.id,
      );
      db.prepare(
        'INSERT INTO tests (user_id, mode, start_pos, end_pos, wpm, raw_wpm, accuracy, chars, duration_ms, xp, committed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(user.id, mode, startPos, endPos, stats.wpm, stats.rawWpm, accuracy, typed.length, Math.round(durationMs), xpGained, counts ? 1 : 0, now);

      if (counts) {
        const testsCount = db.prepare('SELECT COUNT(*) AS n FROM tests WHERE user_id = ? AND committed = 1').get(user.id).n;
        const owned = new Set(db.prepare('SELECT badge_id FROM badges WHERE user_id = ?').all(user.id).map((b) => b.badge_id));
        const ids = qualifyingBadges({
          wpm: stats.wpm, accuracy, chars: typed.length, mode, completed, streak, testsCount,
          chaptersDone: doneBefore.size + newChapters.length, arcsDone, bookDone,
        });
        const insert = db.prepare('INSERT INTO badges (user_id, badge_id, earned_at) VALUES (?, ?, ?)');
        for (const id of ids) {
          if (owned.has(id)) continue;
          insert.run(user.id, id, now);
          newBadges.push(BADGES.find((b) => b.id === id));
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
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
      me: buildMe(updated),
    };
  }

  const routes = {
    'GET /api/book': () => [200, BOOK_PAYLOAD],

    'POST /api/register': async (req) => {
      const { username, password } = credentials(await readJson(req));
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
      const { salt, hash } = hashPassword(password);
      const { lastInsertRowid } = db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(username, hash, salt, Date.now());
      const { token, maxAge } = createSession(db, Number(lastInsertRowid));
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
      return [201, { me: buildMe(user) }, { 'Set-Cookie': sessionCookie(token, maxAge) }];
    },

    'POST /api/login': async (req) => {
      const { username, password } = credentials(await readJson(req));
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user || !verifyPassword(password, user.salt, user.pass_hash)) throw new HttpError(401, 'Wrong username or password');
      const { token, maxAge } = createSession(db, user.id);
      return [200, { me: buildMe(user) }, { 'Set-Cookie': sessionCookie(token, maxAge) }];
    },

    'POST /api/logout': (req) => {
      destroySession(db, parseCookies(req.headers.cookie)[COOKIE]);
      return [200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) }];
    },

    'GET /api/me': (req) => [200, { me: buildMe(requireUser(req)) }],

    'POST /api/tests': async (req) => {
      const user = requireUser(req);
      return [200, submitTest(user, await readJson(req))];
    },

    'GET /api/history': (req) => {
      const user = requireUser(req);
      const tests = db
        .prepare('SELECT mode, start_pos, end_pos, wpm, raw_wpm, accuracy, chars, duration_ms, xp, committed, created_at FROM tests WHERE user_id = ? ORDER BY id DESC LIMIT 30')
        .all(user.id);
      const best = db.prepare('SELECT mode, MAX(wpm) AS wpm FROM tests WHERE user_id = ? AND committed = 1 GROUP BY mode').all(user.id);
      return [200, { tests, bestByMode: Object.fromEntries(best.map((b) => [b.mode, b.wpm])) }];
    },

    'GET /api/leaderboard': () => {
      const rows = db.prepare('SELECT username, xp, best_wpm, ranges FROM users ORDER BY xp DESC, id ASC LIMIT 25').all();
      return [200, {
        leaders: rows.map((r) => {
          const level = levelForXp(r.xp);
          return {
            username: r.username, xp: r.xp, level, rank: rankForLevel(level), bestWpm: r.best_wpm,
            chapters: completedChapterIds(JSON.parse(r.ranges)).length,
          };
        }),
      }];
    },
  };

  async function serveStatic(req, res, pathname) {
    for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
      if (!pathname.startsWith(prefix)) continue;
      const rel = pathname.slice(prefix.length) || 'index.html';
      const file = normalize(join(dir, rel));
      if (!file.startsWith(dir)) break;
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': `${MIME[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
        res.end(data);
        return;
      } catch {
        break;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      const handler = routes[`${req.method} ${pathname}`];
      if (handler) {
        const [status, body, headers] = await handler(req);
        return send(res, status, body, headers);
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      await serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong' });
    }
  });

  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const dbPath = process.env.DB_PATH || join(ROOT, 'data', 'typemaster.db');
  createApp({ dbPath }).listen(port, () => console.log(`Type Master running at http://localhost:${port}`));
}
