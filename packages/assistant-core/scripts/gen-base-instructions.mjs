// Writes src/base-instructions.ts from src/base-instructions.md: the server is bundled (`mastra
// build`), so the shipped text travels as a module; base-instructions.test.ts fails when they drift.
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync(new URL('../src/base-instructions.md', import.meta.url), 'utf8');
writeFileSync(
  new URL('../src/base-instructions.ts', import.meta.url),
  '// Generated from base-instructions.md by scripts/gen-base-instructions.mjs: edit the .md, then run it.\n' +
    `export const BASE_INSTRUCTIONS_MARKDOWN = ${JSON.stringify(md)};\n`,
);
