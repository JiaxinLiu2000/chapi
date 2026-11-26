# -*- coding: utf-8 -*-
"""Shared builder for the printed CS6140 study sheets: Letter, two columns, 8pt body, black & white,
**bold** + $LaTeX$ (→ native Word equations), tables fixed to column width, figures."""
import re, os
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from tbl_width import fit_table
from omml import add_rich

BODY, LATIN, CJK = 8, "Calibri", "Microsoft YaHei"
BLACK, GREY, DARK, WHITE = RGBColor(0, 0, 0), RGBColor(0x40, 0x40, 0x40), RGBColor(0x30, 0x30, 0x30), RGBColor(0xFF, 0xFF, 0xFF)
COLW = 3.62

def fonts(run, size=BODY, bold=None, color=None, italic=None):
    run.font.name, run.font.size = LATIN, Pt(size)
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), CJK)
    if bold is not None: run.bold = bold
    if italic is not None: run.italic = italic
    if color is not None: run.font.color.rgb = color

def shade(el, fill):
    pr = el.get_or_add_pPr() if el.tag.endswith("}p") else el.get_or_add_tcPr()
    s = OxmlElement("w:shd"); s.set(qn("w:val"), "clear"); s.set(qn("w:color"), "auto"); s.set(qn("w:fill"), fill)
    pr.append(s)

def keep_next(p): p.paragraph_format.keep_with_next = True

class Sheet:
    def __init__(self, title, subtitle):
        self.doc = d = Document()
        st = d.styles["Normal"]; st.font.name, st.font.size = LATIN, Pt(BODY)
        st.element.rPr.rFonts.set(qn("w:eastAsia"), CJK)
        pf = st.paragraph_format; pf.space_before, pf.space_after, pf.line_spacing = Pt(0), Pt(1), 1.0
        s0 = d.sections[0]; self._margins(s0); self._cols(s0, 1, sep=False)
        p = d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; fonts(p.add_run(title), 13, bold=True, color=BLACK)
        p = d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; self.rich(p, subtitle, 7.5, color=GREY)
        foot = s0.footer.paragraphs[0]; foot.alignment = WD_ALIGN_PARAGRAPH.CENTER; self._page_field(foot)
        s1 = d.add_section(WD_SECTION.CONTINUOUS); self._margins(s1); self._cols(s1, 2)

    # ---- layout helpers
    @staticmethod
    def _margins(s):
        s.page_width, s.page_height = Inches(8.5), Inches(11)
        s.left_margin = s.right_margin = Inches(0.45); s.top_margin, s.bottom_margin = Inches(0.45), Inches(0.5)
        s.header_distance, s.footer_distance = Inches(0.25), Inches(0.25)

    @staticmethod
    def _cols(s, n, space_in=0.22, sep=True):
        sp = s._sectPr
        for c in sp.findall(qn("w:cols")): sp.remove(c)
        cols = OxmlElement("w:cols"); cols.set(qn("w:num"), str(n)); cols.set(qn("w:space"), str(int(space_in * 1440)))
        if sep: cols.set(qn("w:sep"), "1")
        sp.append(cols)

    @staticmethod
    def _page_field(p):
        r = p.add_run(); fonts(r, 7)
        for tag, txt in (("begin", None), (None, "PAGE"), ("end", None)):
            if tag:
                f = OxmlElement("w:fldChar"); f.set(qn("w:fldCharType"), tag); r._element.append(f)
            else:
                t = OxmlElement("w:instrText"); t.set(qn("xml:space"), "preserve"); t.text = txt; r._element.append(t)

    # ---- text
    @staticmethod
    def rich(p, text, size=BODY, color=None, italic=None, bold_all=False):
        def run_fn(run, sz, bold=None, color=None):
            fonts(run, sz, bold=True if bold_all else bold, color=color, italic=italic)
        add_rich(p, text, run_fn, size, color)

    def band(self, text, size=10, fill="404040", color=WHITE, before=4):
        p = self.doc.add_paragraph(); keep_next(p); p.paragraph_format.space_before = Pt(before); p.paragraph_format.space_after = Pt(2)
        self.rich(p, text, size, color=color, bold_all=True); shade(p._p, fill)

    def title(self, text, src=None, prefix=None, size=8.5):
        p = self.doc.add_paragraph(); keep_next(p); p.paragraph_format.space_before = Pt(3)
        if prefix: fonts(p.add_run(prefix), size, bold=True, color=BLACK)
        self.rich(p, text, size, color=BLACK, bold_all=True)
        if src: fonts(p.add_run(f"  〔{src}〕"), 6.5, color=GREY)

    def line(self, text, label=None, italic=False, color=DARK, size=BODY, keep=True):
        p = self.doc.add_paragraph(); keep and keep_next(p)
        if label: fonts(p.add_run(label), size, bold=True, color=BLACK)
        self.rich(p, text, size, color=color, italic=italic)
        return p

    @staticmethod
    def complex_math(latex):
        """Formulas that should sit on their own line: long, or fraction combined with a sum/product, or nested fractions."""
        vis = re.sub(r"\\(mathrm|mathbf|text|left|right|cdot|mid|,|;|quad)\b", "", latex)
        vis = len(re.sub(r"[{}\\\s]|\^|_", "", re.sub(r"\\[a-zA-Z]+", "x", vis)))  # ~ number of visible glyphs
        nested = re.search(r"\\frac\{[^{}]*(\{[^{}]*\}[^{}]*)*\\frac", latex) or re.search(r"\\frac\{[^{}]*\}\{[^{}]*\\frac", latex)
        sumfrac = "\\frac" in latex and ("\\sum" in latex or "\\prod" in latex)
        return vis >= 40 or (nested and vis >= 12) or (sumfrac and vis >= 18)

    def bullet(self, text, mark="• "):
        """Bullet; complex $...$ formulas are pulled out onto their own centered line (rest of the text continues below)."""
        parts = re.split(r"(\$[^$]+\$)", text)
        chunks, cur = [], ""
        for part in parts:
            # a formula at the very start of the bullet stays inline (no lonely bullet mark)
            if part.startswith("$") and part.endswith("$") and len(part) > 2 and self.complex_math(part[1:-1]) and (cur.strip() or chunks):
                chunks.append(("t", cur)); chunks.append(("m", part)); cur = ""
            else:
                cur += part
        chunks.append(("t", cur))
        first = True
        for kind, s in chunks:
            if kind == "t":
                s2 = s.strip()
                if not first: s2 = s2.lstrip("，。；、,.;:：").strip()
                if not s2 and not first: continue
                p = self.doc.add_paragraph(); f = p.paragraph_format; f.left_indent = Inches(0.11)
                if first:
                    f.first_line_indent = Inches(-0.09); fonts(p.add_run(mark), BODY, color=BLACK); first = False
                if s2: self.rich(p, s2)
            else:
                if first:  # bullet starts with a display formula: still print the mark
                    p = self.doc.add_paragraph(); p.paragraph_format.left_indent = Inches(0.11); p.paragraph_format.first_line_indent = Inches(-0.09)
                    fonts(p.add_run(mark), BODY, color=BLACK); first = False
                p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_before = Pt(1); p.paragraph_format.space_after = Pt(1)
                from omml import omath
                p._p.append(omath(s[1:-1].strip(), BODY + 1))

    def table(self, rows):
        ncol = max(len(r) for r in rows); d = self.doc
        t = d.add_table(rows=len(rows), cols=ncol); t.style = "Table Grid"; t.alignment = WD_TABLE_ALIGNMENT.CENTER
        for i, row in enumerate(rows):
            for j in range(ncol):
                val = row[j] if j < len(row) else ""
                cell = t.cell(i, j); cell.text = ""
                cp = cell.paragraphs[0]; cp.paragraph_format.space_after = Pt(0)
                hdr = i == 0 or (len(row) > 1 and list(row[1:]) == list(rows[0][1:]))  # repeated mid-table header row
                self.rich(cp, str(val), 7, bold_all=hdr)
                if hdr: shade(cell._tc, "D9D9D9")
                mar = OxmlElement("w:tcMar")
                for side in ("left", "right"):
                    m = OxmlElement(f"w:{side}"); m.set(qn("w:w"), "50"); m.set(qn("w:type"), "dxa"); mar.append(m)
                cell._tc.get_or_add_tcPr().append(mar)
        fit_table(t, [[re.sub(r"\$[^$]*\$", "xxxxx", str(c)) for c in r] for r in rows])
        trPr = t.rows[0]._tr.get_or_add_trPr(); h = OxmlElement("w:tblHeader"); h.set(qn("w:val"), "true"); trPr.append(h)
        for r in t.rows[:2]:
            for cell in r.cells: keep_next(cell.paragraphs[0])
        for r in t.rows:
            c = OxmlElement("w:cantSplit"); c.set(qn("w:val"), "true"); r._tr.get_or_add_trPr().append(c)
        sp = d.add_paragraph(); sp.paragraph_format.space_after = Pt(0); fonts(sp.add_run(""), 3)

    def figures(self, paths_widths, cap=None, keep=False):
        p = self.doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; keep and keep_next(p)
        for i, (path, w) in enumerate(paths_widths):
            if i: p.add_run("  ")
            p.add_run().add_picture(path, width=Inches(w))
        if cap:
            c = self.doc.add_paragraph(); c.alignment = WD_ALIGN_PARAGRAPH.CENTER; self.rich(c, cap, 6.5, color=GREY, italic=True)

    def save(self, out, title):
        self.doc.core_properties.title = title; self.doc.save(out)
