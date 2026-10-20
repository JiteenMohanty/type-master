# Type Master · Hanuman Katha

A typing practice site where, instead of random paragraphs, you type the whole life story of Lord Hanuman, from his birth to the Mahabharata, in 34 chapters across 6 arcs.

## Features

- **The book**: about 13,500 words of original retelling (`content/arcs/`), in plain ASCII so every character can be typed.
  - Birth and childhood: Anjana's curse, the leap at the sun, Indra's vajra, the boons, the curse of forgetting, studying under Surya.
  - Kishkindha, the journey to Lanka (Sundara Kanda) and the war.
  - Ayodhya, including the pearl necklace, the sindoor story and becoming a Chiranjeevi.
  - The Mahabharata: Bhima, Arjuna's banner, Garuda's pride.
- **Automatic bookmark**: each test continues from where the last one ended. The chapter index shows per-chapter % typed, and you can jump to any chapter.
- **Test modes**: 1, 3 and 5 minute tests, and 1 page and 2 page tests (1 page = about 1,500 characters).
- **Rewards**:
  - XP, worth correct words times accuracy squared.
  - Bonuses for each chapter, arc and the whole book.
  - Levels with ranks (Vanara Cub up to Chiranjeevi).
  - 22 badges: speed, accuracy, streaks, test counts, one per arc, and the full book.
  - Daily streaks and a leaderboard.
- **Accounts**:
  - Username and password, hashed with scrypt.
  - HttpOnly session cookie.
  - Progress, history and badges are stored in SQLite.

### Progress rules

- Only whole words count towards progress.
- A test moves your bookmark and earns XP only if at least 75% of the typed characters are correct.
- The server checks typed text against the book and rejects implausible results (over 300 WPM, or timings that don't fit the mode).

## Run

Requires **Node.js 22.5+**. There are no npm dependencies: it uses the built-in `node:sqlite` and `crypto` modules.

```sh
npm start          # http://localhost:3000
npm test
```

Environment variables:

- `PORT`: default `3000`.
- `DB_PATH`: default `data/typemaster.db`.

## Layout

```
content/arcs/*.js   story text, one file per arc
content/book.js     joins chapters into one text with chapter offsets
shared/engine.js    modes, passage slicing, scoring, coverage ranges (server + browser)
server/             http server, auth, db schema, rewards/badges
public/             single-page frontend (vanilla JS)
tests/              node:test unit + API tests
```
