#!/usr/bin/env python3
"""Rewrite TypeScript constructor parameter properties into fields.

`constructor(private readonly x: T) {}` is not erasable syntax, so Node cannot
strip it and `erasableSyntaxOnly` rejects it. This turns each such parameter into
a field declaration above the constructor plus an assignment right after the
`super(...)` call (or at the top of the body when there is none).

Usage: erase-parameter-properties.py FILE:LINE [FILE:LINE ...]
LINE is any line inside the constructor's parameter list, as tsc reports TS1294.
"""

import re
import sys

MODIFIERS = ('public', 'private', 'protected', 'readonly', 'override')


def match_close(text, open_index):
    pairs = {'(': ')', '[': ']', '{': '}', '<': '>'}
    stack = []
    i = open_index
    in_string = None
    while i < len(text):
        c = text[i]
        if in_string:
            if c == '\\':
                i += 2
                continue
            if c == in_string:
                in_string = None
        elif c in '\'"`':
            in_string = c
        elif text.startswith('//', i):
            i = text.index('\n', i)
            continue
        elif text.startswith('/*', i):
            i = text.index('*/', i) + 2
            continue
        elif c in '([{':
            stack.append(pairs[c])
        elif c in ')]}':
            stack.pop()
            if not stack:
                return i
        i += 1
    raise ValueError('unbalanced')


def split_top_level(params):
    parts, depth, start, in_string = [], 0, 0, None
    i = 0
    while i < len(params):
        c = params[i]
        if not in_string and params.startswith('//', i):
            i = params.index('\n', i)
            continue
        if not in_string and params.startswith('/*', i):
            i = params.index('*/', i) + 2
            continue
        if in_string:
            if c == '\\':
                i += 2
                continue
            if c == in_string:
                in_string = None
        elif c in '\'"`':
            in_string = c
        elif c in '([{<':
            depth += 1
        elif c in ')]}>':
            if not (c == '>' and i > 0 and params[i - 1] == '='):
                depth -= 1
        elif c == ',' and depth == 0:
            parts.append(params[start:i])
            start = i + 1
        i += 1
    parts.append(params[start:])
    return [p for p in parts if p.strip()]


def rewrite(text, line):
    offset = sum(len(l) + 1 for l in text.split('\n')[: line - 1])
    ctor = text.rfind('constructor(', 0, offset + 200)
    while ctor != -1:
        close = match_close(text, ctor + len('constructor'))
        if close >= offset:
            break
        ctor = text.rfind('constructor(', 0, ctor)
    open_paren = ctor + len('constructor')
    close = match_close(text, open_paren)
    params = split_top_level(text[open_paren + 1 : close])

    fields, assigns, new_params = [], [], []
    for raw in params:
        leading = re.match(r'\s*((?:/\*\*.*?\*/\s*)?)', raw, re.S).group(1)
        body = raw[len(re.match(r'\s*', raw).group(0)) + len(leading) :].strip()
        mods = []
        while True:
            m = re.match(r'(%s)\s+' % '|'.join(MODIFIERS), body)
            if not m:
                break
            mods.append(m.group(1))
            body = body[m.end() :]
        if not mods:
            new_params.append(raw.strip())
            continue
        name = re.match(r'[A-Za-z_$][\w$]*', body).group(0)
        rest = body[len(name) :]
        optional = rest.startswith('?')
        rest = rest[1:] if optional else rest
        type_text = None
        if rest.lstrip().startswith(':'):
            type_part = rest.lstrip()[1:]
            depth, cut = 0, len(type_part)
            for i, c in enumerate(type_part):
                if c in '([{<':
                    depth += 1
                elif c in ')]}>' and not (c == '>' and type_part[i - 1] == '='):
                    depth -= 1
                elif c == '=' and depth == 0 and type_part[i + 1 : i + 2] != '>':
                    cut = i
                    break
            type_text = type_part[:cut].strip()
        field_mods = [m for m in mods if m != 'override'] or ['public']
        if field_mods == ['public']:
            field_mods = []
        decl = ' '.join(field_mods + [name + ('?' if optional else '') + (': ' + type_text if type_text else '') + ';'])
        fields.append((leading.strip(), decl))
        assigns.append(f'this.{name} = {name};')
        new_params.append((leading + body).strip())

    if not fields:
        return text
    indent = text[text.rfind('\n', 0, ctor) + 1 : ctor]
    multiline = '\n' in text[open_paren:close]
    if multiline:
        inner = '\n'.join(f'{indent}  {p},' for p in new_params)
        param_text = f'(\n{inner}\n{indent})'
    else:
        param_text = '(' + ', '.join(new_params) + ')'
    brace = text.index('{', close)
    body_close = match_close(text, brace)
    body = text[brace + 1 : body_close]
    sup = re.search(r'\bsuper\(', body)
    stmt_indent = indent + '  '
    assign_text = ''.join(f'\n{stmt_indent}{a}' for a in assigns)
    if sup:
        end = match_close(body, sup.end() - 1)
        semi = body.index(';', end) + 1
        new_body = body[:semi] + assign_text + body[semi:]
    elif body.strip():
        new_body = assign_text + body
    else:
        new_body = assign_text + '\n' + indent
    field_text = ''
    for doc, decl in fields:
        if doc:
            field_text += f'{indent}{doc}\n'
        field_text += f'{indent}{decl}\n'
    head = text[: ctor - len(indent)]
    return head + field_text + '\n' + indent + 'constructor' + param_text + text[close + 1 : brace + 1] + new_body + text[body_close:]


def main():
    by_file = {}
    for arg in sys.argv[1:]:
        path, line = arg.rsplit(':', 1)
        by_file.setdefault(path, set()).add(int(line))
    for path, lines in by_file.items():
        text = open(path).read()
        for line in sorted(lines, reverse=True):
            text = rewrite(text, line)
        open(path, 'w').write(text)
        print(f'{path}: {len(lines)} constructor(s)')


if __name__ == '__main__':
    main()
