import pymupdf as f, re, sys
d = f.open(sys.argv[1])
print("pages", d.page_count, "images", sum(len(p.get_images()) for p in d))
B = chr(92)
raw = 0
for i, p in enumerate(d):
    t = p.get_text()
    for l in t.splitlines()[:3]:
        if re.match(r"^第\d+章", l):
            print(i + 1, l[:30])
    for pat in ["frac", "vec", "beta", "tfrac", "sum_", "mathbf", "left(", "begin{"]:
        if B + pat in t:
            raw += 1; print("RAW", i + 1, pat)
    if "$$" in t:
        raw += 1; print("RAW $$", i + 1)
print("raw hits", raw)
for i in [int(x) for x in sys.argv[2:]]:
    if i <= d.page_count:
        d[i - 1].get_pixmap(dpi=60).save(f"check/final_p{i}.png")
