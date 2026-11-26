# -*- coding: utf-8 -*-
"""LaTeX -> MathML (latex2mathml) -> OMML (Office MML2OMML.XSL) for python-docx paragraphs.
Rich text markup used by the generators: **bold**, $inline math$, and a whole bullet/line that is exactly $$display$$."""
import re, copy
from lxml import etree
import latex2mathml.converter as l2m
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

_XSL = etree.XSLT(etree.parse(r"C:\Program Files\Microsoft Office\root\Office16\MML2OMML.XSL"))
_cache = {}

def omath(latex, size_pt=8, display=False):
    """Return an <m:oMath> (or <m:oMathPara>) element for the LaTeX string."""
    key = (latex, size_pt, display)
    if key not in _cache:
        mml = l2m.convert(latex, display="inline")
        display = False  # nested oMathPara corrupts the file; display = own centered paragraph instead
        om = _XSL(etree.fromstring(mml)).getroot()  # m:oMath
        # font size + Cambria Math on every run so 8pt body stays consistent
        M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
        W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        # multi-letter words (min, ln, softmax, argmax …) upright, like LaTeX operators
        for r in om.iter(f"{{{M}}}r"):
            t = r.find(f"{{{M}}}t")
            if t is not None and t.text and len(t.text) >= 2 and t.text.isascii() and t.text.isalpha() and r.find(f"{{{M}}}rPr") is None:
                mr = etree.Element(f"{{{M}}}rPr"); sty = etree.SubElement(mr, f"{{{M}}}sty"); sty.set(f"{{{M}}}val", "p"); r.insert(0, mr)
        # w:rPr inside m:r must sit after m:rPr and before m:t
        for r in om.iter(f"{{{M}}}r"):
            for e in r.findall(f"{{{W}}}rPr"): r.remove(e)
            rpr = etree.Element(f"{{{W}}}rPr")
            f = etree.SubElement(rpr, f"{{{W}}}rFonts"); f.set(f"{{{W}}}ascii", "Cambria Math"); f.set(f"{{{W}}}hAnsi", "Cambria Math")
            s = etree.SubElement(rpr, f"{{{W}}}sz"); s.set(f"{{{W}}}val", str(int(size_pt * 2)))
            s2 = etree.SubElement(rpr, f"{{{W}}}szCs"); s2.set(f"{{{W}}}val", str(int(size_pt * 2)))
            mrpr = r.find(f"{{{M}}}rPr")
            r.insert(0 if mrpr is None else list(r).index(mrpr) + 1, rpr)
        if display:
            para = etree.Element(f"{{{M}}}oMathPara"); para.append(om); om = para
        _cache[key] = om
    return copy.deepcopy(_cache[key])

_SEG = re.compile(r"(\$[^$]+\$)")

def add_rich(p, text, run_fn, size_pt=8, color=None):
    """Append text with **bold** and $math$ segments to paragraph p. run_fn(run, size, bold, color) styles text runs."""
    segs = [s for s in _SEG.split(text) if s]
    if segs and all(s.startswith("$") and s.endswith("$") for s in segs):
        run_fn(p.add_run("​"), size_pt, bold=False, color=color)  # math-only paragraph would be centered as display math
    for seg in segs:
        if seg.startswith("$") and seg.endswith("$") and len(seg) > 2:
            p._p.append(omath(seg[1:-1].strip(), size_pt + 1))  # math 1pt larger than text: inline fractions stay legible
            continue
        for i, part in enumerate(re.split(r"\*\*", seg)):
            if part: run_fn(p.add_run(part), size_pt, bold=(i % 2 == 1), color=color)

def check(latex):
    try:
        omath(latex); return None
    except Exception as e:
        return str(e)[:120]
