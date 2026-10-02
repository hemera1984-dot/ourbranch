# 랜딩 도트 장면 글씨(Galmuri11, OFL)를 쓰는 글자만 남겨 자른다 — 원본 504KB를 첫 화면에 다 받지 않게 (2026-10-03 점검).
# 도트 장면 글자는 <script> 안(txt·bubble 호출, 발표자 메모 포함)에만 있으므로 스크립트 안 글자 + ASCII 전부를 남긴다.
# 장면 글자를 바꾸면 다시 돌린다. 실행: python server/tools/subset-galmuri.py
import io, re, os
from fontTools import subset
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
html = io.open(os.path.join(ROOT, "web/recruit/index.html"), encoding="utf-8").read()
chars = set("".join(re.findall(r"<script>([\s\S]*?)</script>", html))) | {chr(c) for c in range(32, 127)} | set("…·「」『』→←")
chars = {c for c in chars if c >= " "}
src = os.path.join(ROOT, "server/tools/fonts/Galmuri11-full.woff2")
out = os.path.join(ROOT, "web/recruit/assets/fonts/Galmuri11.woff2")
opt = subset.Options(); opt.flavor = "woff2"; opt.layout_features = ["*"]
f = subset.load_font(src, opt); s = subset.Subsetter(opt); s.populate(text="".join(sorted(chars))); s.subset(f); subset.save_font(f, out, opt)
print(len(chars), "글자 →", os.path.getsize(out), "바이트")
