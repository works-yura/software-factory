import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, posix, relative, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin, UserConfig } from 'vite';
import { defineConfig } from 'vite';

const srcDir = resolve(__dirname, 'src');

const isEntrySource = (fileName: string) => /\.(ts|tsx)$/.test(fileName) && !/\.(test|stories)\.tsx?$/.test(fileName);

const forEachSourceFile = (directory: string, visit: (file: string) => void) => {
  readdirSync(directory, { withFileTypes: true }).forEach(dirent => {
    if (dirent.name === '__tests__') return;

    const path = resolve(directory, dirent.name);
    if (dirent.isDirectory()) forEachSourceFile(path, visit);
    else if (dirent.isFile() && isEntrySource(dirent.name)) visit(path);
  });
};

const fileEntries = (directory: string, prefix: string) => {
  const sourceDir = resolve(__dirname, directory);
  const entries: Array<[string, string]> = [];

  forEachSourceFile(sourceDir, file => {
    const entryName = relative(sourceDir, file)
      .replace(/\\/g, '/')
      .replace(/\.(ts|tsx)$/, '')
      .replace(/(?:^|\/)index$/, '');

    if (entryName) entries.push([`${prefix}/${entryName}`, file]);
  });

  return Object.fromEntries(entries);
};

const componentEntries = (directory: string, prefix: string) => {
  const sourceDir = resolve(__dirname, directory);
  const entries: Array<[string, string]> = [];

  const walk = (currentDir: string) => {
    readdirSync(currentDir, { withFileTypes: true }).forEach(dirent => {
      if (!dirent.isDirectory() || dirent.name === '__tests__') return;

      const folder = resolve(currentDir, dirent.name);
      const indexFile = resolve(folder, 'index.ts');

      if (!existsSync(indexFile)) {
        walk(folder);
        return;
      }

      entries.push([`${prefix}/${relative(sourceDir, folder).replace(/\\/g, '/')}`, indexFile]);
    });
  };

  walk(sourceDir);

  return Object.fromEntries(entries);
};

// Factory builds without vite-plugin-dts, vite-plugin-lib-inject-css and rollup-plugin-node-externals (not in
// the offline package cache): declarations come from `scripts/emit-declarations.mjs`, the two build plugins below
// replace the other two with the same output layout (`import './x.css'` next to each chunk, bare imports external).
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const externalPackages = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];

// Like rollup-plugin-node-externals: dependencies, peer dependencies (and their subpaths) and Node builtins stay
// imports; devDependencies such as class-variance-authority, clsx and tailwind-merge are bundled.
const isExternal = (id: string) =>
  id.startsWith('node:') ||
  builtinModules.includes(id) ||
  externalPackages.some(name => id === name || id.startsWith(`${name}/`));

/** Keeps a chunk's extracted CSS loaded by importing it from the chunk (library mode drops it otherwise). */
const libInjectCss = (): Plugin => ({
  name: 'factory:lib-inject-css',
  apply: 'build',
  config: () => ({
    build: {
      cssCodeSplit: true,
      rollupOptions: { output: { assetFileNames: '[name][extname]' } },
    },
  }),
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      const css = [...((chunk as { viteMetadata?: { importedCss: Set<string> } }).viteMetadata?.importedCss ?? [])];
      if (css.length === 0) continue;
      const specifiers = css.map(file => {
        const path = posix.relative(posix.dirname(chunk.fileName), file);
        return path.startsWith('.') ? path : `./${path}`;
      });
      if (chunk.fileName.endsWith('.cjs.js') || chunk.fileName.endsWith('.cjs')) {
        const requires = specifiers.map(path => `require('${path}');`).join('');
        const firstRequire = chunk.code.search(/^const [^\n]*require\(/m);
        chunk.code = firstRequire === -1 ? chunk.code + requires : chunk.code.slice(0, firstRequire) + requires + chunk.code.slice(firstRequire);
      } else {
        const imports = specifiers.map(path => `import '${path}';`).join('');
        // After the leading import block, so the chunk's own imports keep their order.
        const lastImport = [...chunk.code.matchAll(/^import[^;]*;[ \t]*\n*/gm)].at(-1);
        const at = lastImport ? lastImport.index + lastImport[0].length : 0;
        chunk.code = chunk.code.slice(0, at) + imports + chunk.code.slice(at);
      }
    }
  },
});

/**
 * Emits the declarations vite-plugin-dts would: `tsc` writes `dist/src/**` (path aliases rewritten to relative
 * specifiers) and every library entry gets a stub `dist/<entry>.d.ts` re-exporting its source module. Fails the
 * build on type errors.
 */
const declarations = (entries: Record<string, string>): Plugin => ({
  name: 'factory:declarations',
  apply: 'build',
  closeBundle() {
    const distDir = resolve(__dirname, 'dist');
    const tsc = resolve(__dirname, 'node_modules/typescript/bin/tsc');
    try {
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: __dirname, stdio: 'inherit' });
    } catch {
      throw new Error('tsc found type error(s) while emitting declarations; see log above.');
    }

    const rewriteAliases = (directory: string) => {
      readdirSync(directory, { withFileTypes: true }).forEach(dirent => {
        const path = resolve(directory, dirent.name);
        if (dirent.isDirectory()) return rewriteAliases(path);
        if (!dirent.name.endsWith('.d.ts')) return;
        const source = readFileSync(path, 'utf8');
        const rewritten = source.replace(/(['"])@\/([^'"]+)\1/g, (_match, quote: string, target: string) => {
          const relativePath = posix.relative(
            posix.dirname(relative(resolve(distDir, 'src'), path).replace(/\\/g, '/')),
            target,
          );
          return `${quote}${relativePath.startsWith('.') ? relativePath : `./${relativePath}`}${quote}`;
        });
        if (rewritten !== source) writeFileSync(path, rewritten);
      });
    };
    rewriteAliases(resolve(distDir, 'src'));

    for (const [name, file] of Object.entries(entries)) {
      const stub = resolve(distDir, `${name}.d.ts`);
      mkdirSync(dirname(stub), { recursive: true });
      const modulePath = relative(srcDir, file).replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '');
      const target = posix.relative(posix.dirname(name), `src/${modulePath}`);
      const hasDefault = /^export default /m.test(readFileSync(file, 'utf8'));
      const specifier = target.startsWith('.') ? target : `./${target}`;
      const exportsSource = name === 'style' ? '' : `export * from '${specifier}'\n${hasDefault ? `export { default } from '${specifier}'\n` : ''}`;
      writeFileSync(stub, `${exportsSource}export {}\n`);
    }

    // Read by scripts/ensure-built.mjs to tell whether dist/ is newer than the sources.
    writeFileSync(resolve(distDir, '.built'), `${new Date().toISOString()}\n`);
  },
});

const appPlugins = [react(), tailwindcss()];

const baseConfig: UserConfig = {
  plugins: appPlugins,
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
};

// Watch builds reuse the previous full build declarations.
const libEntries: Record<string, string> = {
  style: resolve(srcDir, 'style.ts'),
  tokens: resolve(srcDir, 'ds/tokens/index.ts'),
  'lib/framework': resolve(srcDir, 'lib/framework.tsx'),
  ...fileEntries('src/utils', 'utils'),
  ...fileEntries('src/domains', 'domains'),
  ...fileEntries('src/ds/primitives', 'primitives'),
  ...fileEntries('src/lib/resize', 'resize'),
  ...fileEntries('src/lib/keyboard', 'keyboard'),
  ...fileEntries('src/lib/sort', 'sort'),
  ...fileEntries('src/components', 'components'),
  ...fileEntries('src/ds/icons', 'icons'),
  ...fileEntries('src/hooks', 'hooks'),
  ...fileEntries('src/lib/form', 'lib/form'),
  ...componentEntries('src/ds/components', 'components'),
  ...componentEntries('src/ds/layout', 'layout'),
  ...componentEntries('src/ds/new', 'new'),
};

export default defineConfig({
  ...baseConfig,
  plugins: [...appPlugins, libInjectCss(), declarations(libEntries)],
  build: {
    emptyOutDir: true,
    lib: {
      entry: libEntries,
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format}.js`,
    },
    sourcemap: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      external: isExternal,
      output: { hoistTransitiveImports: false },
    },
  },
});
