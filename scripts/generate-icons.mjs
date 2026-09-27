// Generates raster app icons from the NILCODE AI brand marks:
// PNG sizes (16–1024), Windows .ico (PNG-compressed entries), macOS .icns.
// Playwright (already a devDependency) renders the SVG to PNG; the ICO/ICNS
// containers are assembled directly — PNG entries are valid in both formats.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'icons');
mkdirSync(OUT, { recursive: true });

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function rasterize(svgPath, pngPath, size) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.goto(`file://${svgPath.split('\\').join('/')}`);
    await page.screenshot({ path: pngPath, omitBackground: false });
  } finally {
    if (browser) await browser.close();
  }
}

// Windows ICO container over PNG entries.
function buildIco(pngs) {
  const parts = [];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  parts.push(header);

  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // plane
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    parts.push(e);
  }
  for (const p of pngs) parts.push(p.data);
  return Buffer.concat(parts);
}

// macOS ICNS container (PNG-based types).
const ICNS_TYPES = { 32: 'ic04', 128: 'ic07', 256: 'ic09', 512: 'ic10', 1024: 'ic11' };

function buildIcns(pngs) {
  const chunks = [];
  for (const { size, data } of pngs) {
    const type = ICNS_TYPES[size];
    if (!type) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(Buffer.concat([head, data]));
  }
  const total = chunks.reduce((a, c) => a + c.length, 0) + 8;
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

(async () => {
  const svg = join(ROOT, 'public', 'brand', 'icon-dark.svg');
  const pngs = [];
  for (const size of SIZES) {
    const png = join(OUT, `icon-${size}.png`);
    await rasterize(svg, png, size);
    pngs.push({ size, data: readFileSync(png) });
    console.log(`icon-${size}.png`);
  }

  writeFileSync(
    join(OUT, 'nilcode-ai.ico'),
    buildIco(pngs.filter((p) => [16, 32, 48, 64, 128, 256].includes(p.size)))
  );
  writeFileSync(join(OUT, 'nilcode-ai.icns'), buildIcns(pngs));
  console.log('icons written to build/icons');
  process.exit(0);
})();
