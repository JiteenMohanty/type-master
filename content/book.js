// Assembles the arcs into one continuous typing text.
// Chapters are joined by a single space; each chapter records its [start, end) offsets.
import birth from './arcs/1-birth.js';
import kishkindha from './arcs/2-kishkindha.js';
import sundara from './arcs/3-sundara.js';
import war from './arcs/4-war.js';
import ayodhya from './arcs/5-ayodhya.js';
import mahabharata from './arcs/6-mahabharata.js';

const SOURCE_ARCS = [birth, kishkindha, sundara, war, ayodhya, mahabharata];

export const BADGE_FOR_ARC = [
  'Child of the Wind',
  'Friend of Sugriva',
  'Ocean Leaper',
  'Bearer of the Mountain',
  'Heart of Rama',
  'Banner of Arjuna',
];

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function build() {
  const arcs = [];
  const chapters = [];
  const parts = [];
  let offset = 0;

  SOURCE_ARCS.forEach((arc, arcIndex) => {
    const chapterIds = [];
    for (const ch of arc.chapters) {
      const body = normalize(ch.text);
      if (parts.length) offset += 1; // joining space
      const id = chapters.length;
      chapters.push({ id, arcId: arcIndex, number: id + 1, title: ch.title, start: offset, end: offset + body.length });
      chapterIds.push(id);
      parts.push(body);
      offset += body.length;
    }
    arcs.push({ id: arcIndex, title: arc.title, badge: BADGE_FOR_ARC[arcIndex], chapterIds });
  });

  return { arcs, chapters, text: parts.join(' ') };
}

export const book = build();
