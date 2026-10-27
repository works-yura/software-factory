import re, os, sys, json
D=sys.argv[1]; strings=json.load(open(sys.argv[2]))
SKIP_FILES=re.compile(r'^(components/(EmptyState|Logo|CommandPalette)|icons/|tooltip-|product-identity-|traces-data-list-|hooks/use-keyboard-shortcut-label|domains/chat/attachments/message-attachment-info|components/ThemeToggle)')
DROP=re.compile(r'^(M[\d.]|[A-Z]{1,4}$|Mastra$|SourceGraphic$|JavaScript$|TypeScript$|Markdown$|Shell$)')
pat=re.compile(r'''((?:(?:children|label|placeholder|title|tooltip|description|emptyText|"aria-label"|ariaLabel|alt|heading|text)\s*[:=]\s*|[?:]\s))"([A-Z][A-Za-z0-9 ,.…'’?!()/-]{1,80})"''')
HELPER='const __factoryLibT = (text) => globalThis.__factoryLibT?.(text) ?? text;\n'
kept=set(); toplevel=[]
for rel,hits in strings.items():
    if SKIP_FILES.match(rel): continue
    keep={h for h in hits if not DROP.match(h)}
    if not keep: continue
    f=os.path.join(D,rel); src=open(f).read()
    def rep(m):
        if m.group(2) not in keep: return m.group(0)
        kept.add(m.group(2)); return f'{m.group(1)}__factoryLibT("{m.group(2)}")'
    out=pat.sub(rep,src)
    for i,line in enumerate(out.split('\n')):
        if '__factoryLibT("' in line and re.match(r'^ {0,2}\S',line): toplevel.append(f'{rel}:{i+1}: {line.strip()[:110]}')
    open(f,'w').write(HELPER+out)
json.dump(sorted(kept),open(sys.argv[3],'w'),indent=1,ensure_ascii=False)
print(len(kept),'strings'); print('\n'.join(toplevel))
