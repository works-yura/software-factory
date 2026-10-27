import re, os, sys
root='src'; hits=[]
jsx_text=re.compile(r'>\s*([A-Z][A-Za-z][A-Za-z ,.…\'’?!:-]{2,80}?)\s*</')
prop=re.compile(r'''\b(label|placeholder|title|tooltip|description|aria-label|ariaLabel|alt|name|emptyText|heading)=\s*["']([A-Z][A-Za-z][^"'{}]{2,80})["']''')
objprop=re.compile(r'''\b(label|placeholder|title|tooltip|description|name|heading|message):\s*'([A-Z][a-z][^'{}]{2,80})'[,\s}]''')
toast=re.compile(r'''toast\.(?:error|success|info|warning)\(\s*'([^']{3,})'\)''')
for d,_,fs in os.walk(root):
    if 'locales' in d or '__tests__' in d: continue
    for f in fs:
        if not f.endswith(('.tsx','.ts')) or '.test.' in f or f.endswith('.d.ts'): continue
        p=os.path.join(d,f); src=open(p).read()
        for i,line in enumerate(src.split('\n'),1):
            s=line.strip()
            if s.startswith(('//','*','/*','import')) or 'console.' in s or 'throw new' in s: continue
            for rx,g in ((jsx_text,1),(prop,2),(objprop,2),(toast,1)):
                for m in rx.finditer(line):
                    t=m.group(g)
                    if t in ('GitHub','GitLab','Factory','Mastra','Slack','OK','Enter','Escape'): continue
                    hits.append(f'{p}:{i}: {t}')
print('\n'.join(hits)); print(len(hits), file=sys.stderr)
