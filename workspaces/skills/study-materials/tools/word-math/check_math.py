# -*- coding: utf-8 -*-
"""Check a formula-rewritten JSON against its input.
usage: uv run --with latex2mathml --with lxml --with python-docx python check_math.py IN.json OUT.json
- same structure (keys, list lengths); fixed fields (src, fig, img, w, img_first, extra, f, s) unchanged
- every $...$ compiles to Word math (OMML); no Chinese, no ** inside $...$; $ balanced
- digit multiset unchanged after normalizing unicode super/subscripts and removing LaTeX commands
- reports strings that still look like plain-text math (_ ^ ² Σ √ ‖ etc. outside $...$)"""
import json, re, sys, os, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")
from omml import check
FIXED = {"src", "fig", "img", "w", "img_first", "extra", "f", "s", "l"}
SUP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉", "01234567890123456789")
errs, warn = [], []

def digits(s):
    s = s.translate(SUP)
    s = re.sub(r"\\[a-zA-Z]+", " ", s)
    return collections.Counter(re.findall(r"\d", s))

PLAIN = re.compile(r"[_^²³ⁿ₀-₉Σ∑∏√‖∂]|\b[a-zA-Z]\([^)]*\|")

def walk(a, b, path):
    if type(a) != type(b): errs.append(f"{path}: type changed"); return
    if isinstance(a, dict):
        if set(a) != set(b): errs.append(f"{path}: keys differ {sorted(set(a) ^ set(b))}"); return
        for k in a:
            if k in FIXED and a[k] != b[k]: errs.append(f"{path}.{k}: fixed field changed")
            elif k not in FIXED: walk(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if len(a) != len(b): errs.append(f"{path}: len {len(a)}→{len(b)}"); return
        for i, (x, y) in enumerate(zip(a, b)): walk(x, y, f"{path}[{i}]")
    elif isinstance(a, str):
        if b.count("$") % 2: errs.append(f"{path}: unbalanced $"); return
        if b.count("**") % 2: errs.append(f"{path}: unbalanced **")
        segs = re.findall(r"\$([^$]+)\$", b)
        for m in segs:
            if re.search(r"[一-鿿]", m): errs.append(f"{path}: Chinese inside math: {m[:50]}")
            if "**" in m: errs.append(f"{path}: ** inside math")
            e = check(m.strip())
            if e: errs.append(f"{path}: LaTeX error {e} :: {m[:80]}")
        if digits(a) != digits(b):
            d1, d2 = digits(a), digits(b)
            warn.append(f"{path}: digit multiset changed  -{dict(d1 - d2)} +{dict(d2 - d1)}")
        outside = re.sub(r"\$[^$]+\$", " ", b)
        if PLAIN.search(outside): warn.append(f"{path}: plain-text math left? {outside[max(0, PLAIN.search(outside).start() - 25):PLAIN.search(outside).start() + 35]}")

fi, fo = sys.argv[1], sys.argv[2]
A, B = json.load(open(fi, encoding="utf-8")), json.load(open(fo, encoding="utf-8"))
walk(A, B, os.path.basename(fo))
n_math = len(re.findall(r"\$[^$]+\$", json.dumps(B, ensure_ascii=False)))
print(f"{fo}: math segments={n_math}, errors={len(errs)}, warnings={len(warn)}")
for e in errs[:60]: print("ERR ", e)
for w in warn[:60]: print("WARN", w)
