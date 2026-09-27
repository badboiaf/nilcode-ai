// NULLCODE logo generator.
// Two-line typographic mark: "</NULL" / "CODE>" — monoline geometric letterforms
// drawn as precise stroke paths so light/dark versions share identical geometry.
// Run: node scripts/generate-logo.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'brand');

const T = 14;        // stroke width (monoline weight)
const GAP = 18;      // letter spacing
const LINE_GAP = 40; // gap between the two rows
const PAD = 48;      // generous whitespace around the mark

// Each glyph: visual box 0..w wide, 0..100 tall (cap height), defined as stroke paths.
const GLYPHS = {
  chevL: { w: 66, d: ['M60,22 L8,50 L60,78'] },
  chevR: { w: 66, d: ['M6,22 L58,50 L6,78'] },
  slash: { w: 42, d: ['M6,80 L36,20'] },
  N: { w: 66, d: ['M7,0 L7,100', 'M7,0 L59,100', 'M59,0 L59,100'] },
  U: { w: 70, d: ['M7,0 L7,65 A28,28 0 0 0 63,65 L63,0'] },
  L: { w: 58, d: ['M7,0 L7,100 L58,100'] },
  C: { w: 80, d: ['M69.75,25.91 A36,36 0 1 0 69.75,74.09'] },
  O: { w: 78, d: ['M39,7 A32,43 0 1 0 39.01,7 Z'] }, // full ellipse as arc pair
  D: { w: 74, d: ['M7,0 L7,100', 'M7,7 L24,7 A43,43 0 0 1 24,93 L7,93'] },
  E: { w: 62, d: ['M7,0 L7,100', 'M7,7 L62,7', 'M7,50 L55,50', 'M7,93 L62,93'] },
};

// O as a closed ellipse arc (two arcs for full coverage)
GLYPHS.O.d = ['M39,7 A32,43 0 1 0 39,93 A32,43 0 1 0 39,7'];

function linePath(chars, x0, y0) {
  let x = x0;
  const paths = [];
  for (const ch of chars) {
    const g = GLYPHS[ch];
    for (const d of g.d) {
      paths.push({ d, transform: `translate(${x} ${y0})` });
    }
    x += g.w + GAP;
  }
  return { paths, width: x - GAP - x0 };
}

function measure(chars) {
  return chars.reduce((acc, ch) => acc + GLYPHS[ch].w + GAP, 0) - GAP;
}

function svg(doc, w, h) {
  const body = doc.paths
    .map((p) => `    <path d="${p.d}"${p.transform ? ` transform="${p.transform}"` : ''}/>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${doc.bg}"/>
  <g fill="none" stroke="${doc.fg}" stroke-width="${T}" stroke-linecap="butt" stroke-linejoin="miter">
${body}
  </g>
</svg>
`;
}

function wordmark(fg, bg) {
  const l1 = ['chevL', 'slash', 'N', 'U', 'L', 'L'];
  const l2 = ['C', 'O', 'D', 'E', 'chevR'];
  const w1 = measure(l1);
  const w2 = measure(l2);
  const W = Math.max(w1, w2) + PAD * 2;
  const H = 100 + LINE_GAP + 100 + PAD * 2;
  const doc = {
    fg,
    bg,
    paths: [
      ...linePath(l1, (W - w1) / 2, PAD).paths,
      ...linePath(l2, (W - w2) / 2, PAD + 100 + LINE_GAP).paths,
    ],
  };
  return svg(doc, W, H);
}

// Compact icon derived from the same identity: "<" and ">" stacked in two rows,
// echoing the two-line mark for small sizes (app icon, favicon).
function icon(fg, bg) {
  const s = 1.1;
  const cap = 100 * s;
  const cw = 66 * s;
  const W = 300;
  const H = 300;
  const t = +(T * s).toFixed(1);
  const doc = {
    fg,
    bg,
    paths: [
      { d: GLYPHS.chevL.d[0], transform: `translate(48 40) scale(${s})` },
      { d: GLYPHS.chevR.d[0], transform: `translate(${W - 48 - cw} 190) scale(${s})` },
    ],
  };
  const out = svg(doc, W, H).replace(`stroke-width="${T}"`, `stroke-width="${t}"`);
  return out;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'logo-light.svg'), wordmark('#000000', '#ffffff'));
writeFileSync(join(OUT, 'logo-dark.svg'), wordmark('#ffffff', '#000000'));
writeFileSync(join(OUT, 'icon-light.svg'), icon('#000000', '#ffffff'));
writeFileSync(join(OUT, 'icon-dark.svg'), icon('#ffffff', '#000000'));
writeFileSync(join(OUT, 'favicon.svg'), icon('#000000', '#ffffff'));
console.log('Logo assets written to public/brand/');
