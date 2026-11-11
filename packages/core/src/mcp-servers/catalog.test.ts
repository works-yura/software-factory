import { describe, expect, it } from 'vitest';

import { McpCatalogError, mcpCatalogEntry, mcpCatalogVariant, mcpServerSlug, uniqueMcpServerSlug } from './catalog.ts';

/** A server.json shaped like the MCP Registry's own examples (npm package, named argument, env inputs). */
const manifest = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.example/weather',
  title: 'Weather',
  description: 'Weather data',
  version: '1.2.0',
  repository: { url: 'https://github.com/example/weather', source: 'github' },
  packages: [
    {
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      identifier: '@example/weather-mcp',
      version: '1.2.0',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      packageArguments: [
        { type: 'named', name: '--region', description: 'Region', valueHint: 'region', default: 'eu', choices: ['eu', 'us'] },
        { type: 'named', name: '--stdio', value: '' },
      ],
      environmentVariables: [
        { name: 'WEATHER_API_KEY', description: 'API key', isRequired: true, isSecret: true },
        { name: 'WEATHER_CERT', description: 'Client certificate', format: 'filepath', isSecret: true },
        { name: 'WEATHER_PROJECT', description: 'Project' },
      ],
    },
  ],
  _meta: { 'io.modelcontextprotocol.registry/publisher-provided': { kept: true } },
};

const overlay = {
  server: 'io.github.example/weather',
  id: 'weather',
  label: { uk: 'Погода', en: 'Weather' },
  summary: { uk: 'Дані погоди.', en: 'Weather data.' },
  entrypoint: 'dist/cli.js',
  variants: [
    {
      id: 'default',
      label: { uk: 'Звичайно', en: 'Default' },
      args: ['--region', '${region}', '--stdio'],
      inputs: ['WEATHER_API_KEY', 'WEATHER_CERT', 'WEATHER_PROJECT', 'region'],
      required: ['WEATHER_PROJECT'],
    },
  ],
  inputs: {
    WEATHER_API_KEY: { label: { uk: 'Ключ API', en: 'API key' } },
    WEATHER_CERT: { label: { uk: 'Сертифікат', en: 'Certificate' }, credential: 'google-cloud-account' },
    WEATHER_PROJECT: { label: { uk: 'Проєкт', en: 'Project' }, suggest: 'google-cloud-project' },
    region: { label: { uk: 'Регіон', en: 'Region' } },
  },
};

describe('mcpCatalogEntry', () => {
  it('builds the form from server.json inputs and the overlay, honouring required, secret, file, default and choices', () => {
    const entry = mcpCatalogEntry(manifest, overlay);
    expect(entry.package).toEqual({ registryType: 'npm', identifier: '@example/weather-mcp', version: '1.2.0', entrypoint: 'dist/cli.js' });
    const fields = mcpCatalogVariant(entry, undefined)!.fields;
    expect(fields).toEqual([
      { key: 'WEATHER_API_KEY', kind: 'env', label: { uk: 'Ключ API', en: 'API key' }, required: true, secret: true, file: false },
      {
        key: 'WEATHER_CERT',
        kind: 'env',
        label: { uk: 'Сертифікат', en: 'Certificate' },
        required: false,
        secret: true,
        file: true,
        credential: 'google-cloud-account',
      },
      {
        key: 'WEATHER_PROJECT',
        kind: 'env',
        label: { uk: 'Проєкт', en: 'Project' },
        required: true,
        secret: false,
        file: false,
        suggest: 'google-cloud-project',
      },
      { key: 'region', kind: 'argument', label: { uk: 'Регіон', en: 'Region' }, required: false, secret: false, file: false, default: 'eu', choices: ['eu', 'us'] },
    ]);
  });

  it('fails loudly on a broken manifest, a mismatched overlay, or an input the manifest does not declare', () => {
    expect(() => mcpCatalogEntry({ ...manifest, name: 'not a name' }, overlay)).toThrow(McpCatalogError);
    expect(() => mcpCatalogEntry(manifest, { ...overlay, server: 'io.github.example/other' })).toThrow(/not io.github.example\/weather/);
    expect(() =>
      mcpCatalogEntry(manifest, { ...overlay, variants: [{ ...overlay.variants[0], inputs: ['UNDECLARED'] }] }),
    ).toThrow(/UNDECLARED/);
    expect(() => mcpCatalogEntry({ ...manifest, packages: [{ ...manifest.packages[0], registryType: 'pypi' }] }, overlay)).toThrow(
      /no npm stdio package/,
    );
  });

  it('picks the only variant when none is named, and none when several exist', () => {
    const entry = mcpCatalogEntry(manifest, overlay);
    expect(mcpCatalogVariant(entry, undefined)?.id).toBe('default');
    const two = mcpCatalogEntry(manifest, { ...overlay, variants: [overlay.variants[0], { ...overlay.variants[0], id: 'other' }] });
    expect(mcpCatalogVariant(two, undefined)).toBeUndefined();
    expect(mcpCatalogVariant(two, 'other')?.id).toBe('other');
  });
});

describe('mcpServerSlug', () => {
  it('derives an identifier from a name, Ukrainian included, and keeps it unique', () => {
    expect(mcpServerSlug('Syncta Firestore')).toBe('syncta-firestore');
    expect(mcpServerSlug('База Сінкти')).toBe('baza-sinkty');
    expect(mcpServerSlug('1')).toMatch(/^mcp-/);
    expect(uniqueMcpServerSlug('Syncta Firestore', ['syncta-firestore', 'syncta-firestore-2'])).toBe('syncta-firestore-3');
  });
});
