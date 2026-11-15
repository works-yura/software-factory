// Writes Factory's static brand files from one geometry: the favicon, the session favicons
// (the mark with a status dot) and the PNG app icons (PWA, iOS). The React mark,
// `src/ui/ui/brand/FactoryMark.tsx`, draws the same F; change both together.
//
//   node scripts/brand-icons.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/public');

const PARTS = [
  { x: 8, y: 4, width: 6, height: 24 },
  { x: 8, y: 4, width: 18, height: 6 },
  { x: 8, y: 14, width: 14, height: 6 },
];
const RADIUS = 2;
const rects = cls => PARTS.map(p => `<rect class="${cls}" x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${RADIUS}"/>`).join('\n  ');

// White on dark tabs, black on light ones, as the tab strip follows the system theme.
const INK = `.mark { fill: white; }
    @media (prefers-color-scheme: light) { .mark { fill: black; } }`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <style>
    ${INK}
  </style>
  ${rects('mark')}
</svg>
`;

// A session's state shows as a dot in the corner the F leaves open; each colour has a
// lighter shade for dark tabs and a deeper one for light tabs.
const STATES = {
  initializing: ['oklch(0.623 0.214 259.815)', 'oklch(0.546 0.245 262.881)'],
  working: ['oklch(0.723 0.219 149.579)', 'oklch(0.627 0.194 149.214)'],
  awaiting: ['oklch(0.769 0.188 70.08)', 'oklch(0.666 0.179 58.318)'],
  error: ['oklch(0.637 0.237 25.331)', 'oklch(0.577 0.245 27.325)'],
};

const sessionFavicon = ([dark, light]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <style>
    .mark { fill: white; }
    .dot { fill: ${dark}; }
    @media (prefers-color-scheme: light) {
      .mark { fill: black; }
      .dot { fill: ${light}; }
    }
  </style>
  ${rects('mark')}
  <circle class="dot" cx="26" cy="26" r="5"/>
</svg>
`;

// App icons are maskable: the F stays inside the central 66% (inside the 80% circle every mask keeps).
const appIcon = size => `<!doctype html><html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#0f0f0f"/>
  <g transform="translate(16 16) scale(0.66) translate(-17 -16)" fill="#ffffff">
    ${rects('mark')}
  </g>
</svg></body></html>`;

await writeFile(path.join(PUBLIC, 'factory.svg'), favicon);
for (const [state, shades] of Object.entries(STATES)) {
  await writeFile(path.join(PUBLIC, `favicon-session-${state}.svg`), sessionFavicon(shades));
}

const browser = await chromium.launch();
try {
  for (const [file, size] of [
    ['pwa-192.png', 192],
    ['pwa-512.png', 512],
    ['apple-touch-icon.png', 180],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(appIcon(size));
    await page.screenshot({ path: path.join(PUBLIC, file), omitBackground: false });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('brand icons written to', PUBLIC);
