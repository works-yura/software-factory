import re, os, sys, json
D=sys.argv[1]; used=[l.strip() for l in open(sys.argv[2]) if l.strip()]
seen=set(); stack=[]
for u in used:
    f=os.path.join(D,u+'.es.js')
    if os.path.exists(f): stack.append(os.path.normpath(f))
while stack:
    f=stack.pop()
    if f in seen: continue
    seen.add(f)
    for m in re.finditer(r"from '(\.[^']+)'", open(f).read()):
        stack.append(os.path.normpath(os.path.join(os.path.dirname(f), m.group(1))))
pat=re.compile(r'''(?:(?:children|label|placeholder|title|tooltip|description|emptyText|"aria-label"|ariaLabel|alt|heading|text)\s*[:=]\s*|[?:]\s)"([A-Z][A-Za-z0-9 ,.…'’?!()/-]{1,80})"''')
out={}
for f in sorted(seen):
    hits=sorted(set(m.group(1) for m in pat.finditer(open(f).read())))
    hits=[h for h in hits if h not in ('Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Home','End','Space')]
    if hits: out[os.path.relpath(f,D)]=hits
json.dump(out,open(sys.argv[3],'w'),indent=1,ensure_ascii=False)
print(len(seen),'files', len(out),'with strings', sum(map(len,out.values())),'strings')
