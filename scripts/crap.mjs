#!/usr/bin/env node
// CRAP per function: complexity² × (1 − coverage)³ + complexity.
//
// High CRAP means complex code the tests barely run: where a change breaks
// something nobody notices. Cyclomatic complexity comes from the TypeScript
// AST (1 + each if, ?:, case, loop, catch, &&, ||, ??); coverage is the share
// of a function's statements the tests ran, from a vitest v8 coverage report
// (coverage/coverage-final.json, written by `vitest run --coverage`).
//
// Usage (from the repo root):
//   node scripts/crap.mjs <package-dir> [--threshold 30] [--top 20] [--files a.ts,b.ts]
// Exits 1 when a function is above the threshold, so a package can gate on it.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

// TypeScript 7 is native and has no JS API; the 6.x line parses for us.
const ts = createRequire(import.meta.url)('typescript');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const dir = resolve(argv.find((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--')) ?? '.');
const threshold = Number(option('threshold', '30'));
const top = Number(option('top', '20'));
const only = option('files', '')
  .split(',')
  .filter(Boolean);

const coverage = JSON.parse(readFileSync(join(dir, 'coverage', 'coverage-final.json'), 'utf8'));

const DECISIONS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);
const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const isFunction = node =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

function complexityOf(fn) {
  let count = 1;
  const visit = node => {
    if (node !== fn && isFunction(node)) return; // A nested function is its own entry.
    if (DECISIONS.has(node.kind)) count++;
    if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind)) count++;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return count;
}

function nameOf(fn, source) {
  if (fn.name) return fn.name.getText(source);
  if (ts.isConstructorDeclaration(fn)) return 'constructor';
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText(source);
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  if (parent && ts.isPropertyDeclaration(parent)) return parent.name.getText(source);
  if (parent && ts.isCallExpression(parent)) return `(callback of ${parent.expression.getText(source).slice(0, 40)})`;
  return '(anonymous)';
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);

const rows = [];
for (const [file, data] of Object.entries(coverage)) {
  if (only.length && !only.some(name => file.endsWith(name))) continue;
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const statements = Object.entries(data.statementMap).map(([id, loc]) => ({ loc, hits: data.s[id] }));
  const visit = node => {
    if (isFunction(node) && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.getEnd());
      const from = { line: start.line + 1, column: start.character };
      const to = { line: end.line + 1, column: end.character };
      // Statements inside the function, nested functions' statements included: they run only if it does.
      const inside = statements.filter(st => before(from, st.loc.start) && before(st.loc.end, to));
      const covered = inside.filter(st => st.hits > 0).length;
      const share = inside.length ? covered / inside.length : 1;
      const complexity = complexityOf(node);
      const crap = complexity ** 2 * (1 - share) ** 3 + complexity;
      rows.push({ file: relative(dir, file), line: from.line, name: nameOf(node, source), complexity, coverage: share, crap });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

rows.sort((a, b) => b.crap - a.crap);
const over = rows.filter(row => row.crap > threshold);
const pad = (value, width) => String(value).padEnd(width);
console.log(`${pad('CRAP', 7)}${pad('cx', 4)}${pad('cov', 6)}function`);
for (const row of rows.slice(0, top)) {
  console.log(
    `${pad(row.crap.toFixed(1), 7)}${pad(row.complexity, 4)}${pad(`${Math.round(row.coverage * 100)}%`, 6)}${row.file}:${row.line} ${row.name}`,
  );
}
console.log(`\n${rows.length} functions; ${over.length} above CRAP ${threshold}.`);
process.exit(over.length ? 1 : 0);
