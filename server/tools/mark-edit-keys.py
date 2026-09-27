# 랜딩(web/recruit/index.html)의 글 칸·그림에 data-k 표식을 붙인다 — 「고치기」 모드가 이 표식으로 고친 곳을 기억한다.
# 이미 붙은 표식은 그대로 두고 새로 생긴 칸에만 붙이므로 몇 번 돌려도 된다(표식이 바뀌면 저장된 수정이 떨어져 나간다).
# 실행: python server/tools/mark-edit-keys.py web/recruit/index.html
import io, re, sys
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
SKIP = {"script", "style", "svg", "textarea", "select", "option", "title", "head", "template", "noscript"}
INLINE_OK = {"br", "b", "strong", "em", "i", "mark", "small", "span"}   # 글 칸 안에 들어 있어도 되는 것

class Node:
    def __init__(s, tag, attrs, start, end_of_start, parent):
        s.tag, s.attrs, s.start, s.eos, s.parent = tag, dict(attrs), start, end_of_start, parent
        s.children, s.text, s.bad = [], False, False

class P(HTMLParser):
    def __init__(s, src):
        super().__init__(convert_charrefs=True)
        s.src = src
        s.lines = [0]
        for m in re.finditer("\n", src): s.lines.append(m.end())
        s.root = Node("root", [], 0, 0, None); s.cur = s.root; s.skip = 0
    def off(s):
        l, c = s.getpos(); return s.lines[l - 1] + c
    def handle_starttag(s, tag, attrs):
        o = s.off(); n = Node(tag, attrs, o, o + len(s.get_starttag_text()), s.cur)
        n.skip = s.skip > 0 or tag in SKIP
        s.cur.children.append(n)
        if tag not in VOID:
            if tag in SKIP: s.skip += 1
            s.cur = n
    def handle_startendtag(s, tag, attrs):
        o = s.off(); n = Node(tag, attrs, o, o + len(s.get_starttag_text()), s.cur); n.skip = s.skip > 0
        s.cur.children.append(n)
    def handle_endtag(s, tag):
        if tag in VOID: return
        n = s.cur
        while n is not s.root and n.tag != tag: n = n.parent
        if n is s.root: return
        if n.tag in SKIP: s.skip -= 1
        s.cur = n.parent
    def handle_data(s, d):
        if d.strip() and s.skip == 0: s.cur.text = True

def walk(n):
    yield n
    for c in n.children: yield from walk(c)

def inside(n, pred):
    p = n.parent
    while p is not None:
        if pred(p): return True
        p = p.parent
    return False

def editable_text(n):
    # 글이 바로 들어 있고, 안에 든 것이 글꼴 꾸밈뿐인 칸
    if n.skip or not n.text or n.tag in ("body", "html", "root", "a"): return False
    if "data-me" in n.attrs: return False          # 보여주는 사람 이름 — 화면이 채운다, 고칠 글이 아니다
    for d in walk(n):
        if d is n: continue
        if d.tag not in INLINE_OK or d.skip: return False
    return True

def main(path):
    src = io.open(path, encoding="utf-8").read()
    p = P(src); p.feed(src)
    body = next((x for x in walk(p.root) if x.tag == "body"), None)
    nodes = list(walk(body))
    used = {x.attrs["data-k"] for x in nodes if "data-k" in x.attrs}
    counter = [0]
    def fresh(prefix):
        while True:
            counter[0] += 1
            k = f"{prefix}{counter[0]}"
            if k not in used: used.add(k); return k
    ins = []   # (offset, text)
    taken = set()
    no_zone = lambda x: x.tag in ("aside", "nav") or x.attrs.get("id") in ("pp", "dock")
    for n in nodes:
        if "data-k" in n.attrs or n.skip or inside(n, no_zone) or no_zone(n): continue
        if n.tag == "img":
            ins.append((n.eos - 1 - (1 if src[n.eos - 2] == "/" else 0), f' data-k="{fresh("g")}"'))
            continue
        if not editable_text(n): continue
        if inside(n, lambda a: id(a) in taken or "data-k" in a.attrs and a.tag != "img"): continue
        taken.add(id(n))
        ins.append((n.eos - 1, f' data-k="{fresh("t")}"'))
    for o, t in sorted(ins, reverse=True):
        src = src[:o] + t + src[o:]
    io.open(path, "w", encoding="utf-8", newline="").write(src)
    print(f"새 표식 {len(ins)}개 (글 {sum(1 for _, t in ins if '\"t' in t)} · 그림 {sum(1 for _, t in ins if '\"g' in t)})")

if __name__ == "__main__":
    main(sys.argv[1])
