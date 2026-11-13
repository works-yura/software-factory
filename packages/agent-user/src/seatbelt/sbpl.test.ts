import { describe, expect, it } from 'vitest';

import { pathLookups } from './path-lookups.ts';
import { SbplProfileBuilder } from './profile-builder.ts';
import { globalName, literal, regex, remoteIp, renderFilter, renderRule, sbplString, subpath } from './sbpl.ts';

describe('sbplString', () => {
  it('escapes backslashes and quotes', () => expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"'));
  it.each(['/a\nb', '/a\rb', '/a\0b'])('refuses %j', value => expect(() => sbplString(value)).toThrow());
});

describe('renderFilter / renderRule', () => {
  it('renders every filter kind', () => {
    expect(renderFilter(subpath('/x'))).toBe('(subpath "/x")');
    expect(renderFilter(literal('/x'))).toBe('(literal "/x")');
    expect(renderFilter(regex('^/dev/bpf'))).toBe('(regex #"^/dev/bpf")');
    expect(renderFilter(globalName('com.apple.x'))).toBe('(global-name "com.apple.x")');
    expect(renderFilter(remoteIp('localhost:1'))).toBe('(remote ip "localhost:1")');
    expect(() => renderFilter(regex('a"b'))).toThrow();
  });

  it('renders rules with and without filters and modifiers', () => {
    expect(renderRule({ action: 'allow', operations: ['sysctl-read'] })).toBe('(allow sysctl-read)');
    expect(renderRule({ action: 'allow', operations: ['process-exec'], filters: [literal('/bin/ps')], modifier: '(with no-sandbox)' })).toBe(
      '(allow process-exec\n    (literal "/bin/ps")\n    (with no-sandbox))',
    );
    expect(() => renderRule({ action: 'deny', operations: [] })).toThrow();
  });
});

describe('SbplProfileBuilder', () => {
  it('keeps section order, drops empty sections, starts with version and default', () => {
    const text = new SbplProfileBuilder('hello')
      .byDefault('deny')
      .section({ title: 'first', rules: [{ action: 'allow', operations: ['a'] }] })
      .section({ title: 'empty', rules: [] })
      .section({ title: 'second', rules: [{ action: 'deny', operations: ['b'] }] })
      .build();
    expect(text.indexOf('(version 1)')).toBeLessThan(text.indexOf('(deny default)'));
    expect(text.indexOf(';; first')).toBeLessThan(text.indexOf(';; second'));
    expect(text).not.toContain('empty');
    expect(text.startsWith(';; hello')).toBe(true);
  });
});

describe('pathLookups', () => {
  it('lists every folder above, outermost first, once', () => {
    expect(pathLookups(['/Volumes/dot/Project/factory/sandboxes', '/Users/factory'])).toEqual(['/Volumes', '/Volumes/dot', '/Volumes/dot/Project', '/Volumes/dot/Project/factory', '/Users']);
    expect(pathLookups(['/a'])).toEqual([]);
  });
});
