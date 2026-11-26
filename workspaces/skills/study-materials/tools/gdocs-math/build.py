# -*- coding: utf-8 -*-
"""Assemble draft/ch*.md -> one markdown -> docx (native equations via pandoc).
Usage: uv run --with pypandoc_binary --with python-docx python -I build.py [out.docx]"""
import os, re, sys, glob, subprocess
import pypandoc
from docx import Document
from docx.shared import Pt, RGBColor, Inches
from docx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "CS5100_Midterm_Study_Guide.docx")
REF = os.path.join(HERE, "reference.docx")

# ---------- reference.docx (styles) ----------
def make_reference():
    pandoc = pypandoc.get_pandoc_path()
    data = subprocess.run([pandoc, "--print-default-data-file", "reference.docx"], capture_output=True).stdout
    open(REF, "wb").write(data)
    d = Document(REF)
    def font(st, size=None, bold=None, color=None):
        f = st.font
        f.name = "Arial"
        rpr = st.element.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = rpr.makeelement(qn("w:rFonts"), {}); rpr.append(rf)
        for k in ("w:ascii", "w:hAnsi", "w:cs"): rf.set(qn(k), "Arial")
        rf.set(qn("w:eastAsia"), "Microsoft YaHei")
        if size: f.size = Pt(size)
        if bold is not None: f.bold = bold
        if color: f.color.rgb = RGBColor.from_string(color)
    for name in ("Normal", "Body Text", "First Paragraph", "Compact", "Block Text"):
        try: font(d.styles[name], 11)
        except KeyError: pass
    for name, size, color in (("Title", 24, "1F3864"), ("Subtitle", 13, "404040"), ("Heading 1", 18, "1F3864"),
                              ("Heading 2", 14, "2E5597"), ("Heading 3", 12, "2E5597")):
        try: font(d.styles[name], size, True, color)
        except KeyError: pass
    try:
        bt = d.styles["Block Text"]; bt.font.italic = False; bt.font.color.rgb = RGBColor.from_string("333333")
    except KeyError: pass
    for st in d.styles:
        if st.name in ("Body Text", "First Paragraph", "Compact"):
            st.paragraph_format.space_after = Pt(5)
            st.paragraph_format.line_spacing = 1.2
    d.save(REF)

# ---------- assemble markdown ----------
def chapter_files():
    fs = glob.glob(os.path.join(HERE, "draft", "ch*.md"))
    return sorted(fs, key=lambda p: int(re.search(r"ch(\d+)\.md$", p).group(1)))

PAGEBREAK = '```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```'

def fix_blockquote_lists(txt):
    """pandoc needs an empty quoted line before a list inside a blockquote."""
    out, prev = [], ""
    for line in txt.split("\n"):
        s = line.lstrip()
        if re.match(r"^>\s*(- |\* |\d+\. )", s) and prev.startswith(">") and not re.match(r"^>\s*(- |\* |\d+\. |$)", prev):
            out.append(">")
        out.append(line); prev = s
    return "\n".join(out)

def toc(chapters):
    lines = ["# 目录", ""]
    for txt in chapters:
        fence = False
        for line in txt.split("\n"):
            if line.lstrip().startswith("```"):
                fence = not fence; continue
            if fence: continue
            if line.startswith("# "):
                lines.append(f"**{line[2:].strip()}**"); lines.append("")
            elif line.startswith("## "):
                lines.append(f"- {line[3:].strip()}")
        lines.append("")
    return "\n".join(lines)

def assemble():
    head = ("---\ntitle: \"CS 5100 Foundations of AI · 期中小测（Quiz）零基础复习指南\"\n"
            "subtitle: \"覆盖 16 讲课堂笔记 + HW1–HW4 + 3 份往年小测 · 考试日期 2026-11-16（周一）\"\n---\n")
    chapters = []
    for f in chapter_files():
        txt = open(f, encoding="utf-8").read().strip()
        chapters.append(fix_blockquote_lists(txt))
    parts = [head, toc(chapters)]
    for c in chapters:
        parts += [PAGEBREAK, c]
    md = "\n\n".join(parts) + "\n"
    # pandoc: images relative to cs5100/
    md = md.replace("](../figs/", "](figs/")
    # use downsized copies (Google Docs PDF export has a size limit)
    from PIL import Image
    small = os.path.join(HERE, "figs_small"); os.makedirs(small, exist_ok=True)
    for name in set(re.findall(r"\]\(figs/([^)\s]+)\)", md)):
        src, dst = os.path.join(HERE, "figs", name), os.path.join(small, name)
        if not os.path.exists(src):
            sys.exit(f"missing figure {name}")
        if not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
            im = Image.open(src).convert("RGB")
            if im.width > 950:
                im = im.resize((950, round(im.height * 950 / im.width)), Image.LANCZOS)
            im.quantize(colors=32, method=Image.Quantize.MEDIANCUT).save(dst, optimize=True)
    md = md.replace("](figs/", "](figs_small/")
    md = math_to_images(md)
    p = os.path.join(HERE, "full.md")
    open(p, "w", encoding="utf-8").write(md)
    return p

EX_PT = 5.4          # 1ex in points for ~11.5pt math
MAX_W_IN = 6.3

def math_to_images(md):
    """Google Docs flattens matrices / cases / aligned and does not wrap long equations:
    render those with MathJax into PNG and insert as images."""
    import hashlib, json
    # protect code fences
    fences = []
    def keep(m):
        fences.append(m.group(0)); return f"\x00F{len(fences)-1}\x00"
    md = re.sub(r"```.*?```", keep, md, flags=re.S)
    jobs, repl = {}, []
    def need(tex, display):
        return "\\begin" in tex or (display and len(tex) > 150)
    def job(tex, display):
        h = hashlib.md5((("D" if display else "I") + tex).encode()).hexdigest()[:12]
        jobs[h] = {"id": h, "tex": tex.strip(), "display": display}
        return h
    def disp(m):
        tex = m.group(1)
        if not need(tex, True): return m.group(0)
        return f"\x00D{job(tex, True)}\x00"
    md = re.sub(r"\$\$(.+?)\$\$", disp, md, flags=re.S)
    def inl(m):
        tex = m.group(1)
        if not need(tex, False): return m.group(0)
        return f"\x00I{job(tex, False)}\x00"
    # inside table rows, long inline math does not wrap in Google Docs -> image (marked T)
    def tbl_line(line):
        if not line.lstrip().startswith("|"): return line
        def t(m):
            tex = m.group(1)
            if len(tex) < 22 and "\\begin" not in tex: return m.group(0)
            return f"\x00T{job(tex, False)}\x00"
        return re.sub(r"(?<![\\$])\$([^$\n]+?)\$(?!\$)", t, line)
    md = "\n".join(tbl_line(l) for l in md.split("\n"))
    md = re.sub(r"(?<![\\$])\$([^$\n]+?)\$(?!\$)", inl, md)
    if jobs:
        mj = os.path.join(HERE, "mj"); out = os.path.join(HERE, "mathimg")
        jp = os.path.join(mj, "jobs.json")
        json.dump(list(jobs.values()), open(jp, "w", encoding="utf-8"))
        r = subprocess.run(["node", os.path.join(mj, "render.js"), jp, out], capture_output=True, text=True, encoding="utf-8")
        print(r.stdout.strip(), r.stderr.strip()[:2000])
        meta = json.load(open(os.path.join(out, "meta.json"), encoding="utf-8"))
        from PIL import Image
        for h in jobs:
            pth = os.path.join(out, h + ".png")
            Image.open(pth).convert("L").quantize(colors=8).save(pth, optimize=True)
        def img(kind, h):
            m = meta[h]
            w_in = m["w_ex"] * EX_PT / 72
            if kind == "D":
                w_in = min(w_in, MAX_W_IN)
                return f"\n\n![](mathimg/{h}.png){{width={w_in:.2f}in}}\n\n"
            h_in = m["h_ex"] * EX_PT / 72
            if kind == "T":
                cap = 1.45
                if w_in > cap:
                    return f"![](mathimg/{h}.png){{width={cap:.2f}in}}"
                return f"![](mathimg/{h}.png){{height={h_in:.2f}in}}"
            if w_in > MAX_W_IN:
                return f"\n\n![](mathimg/{h}.png){{width={MAX_W_IN:.2f}in}}\n\n"
            return f"![](mathimg/{h}.png){{height={h_in:.2f}in}}"
        md = re.sub(r"\x00([DIT])([0-9a-f]{12})\x00", lambda m: img(m.group(1), m.group(2)), md)
        print("math images:", len(jobs))
    md = re.sub(r"\x00F(\d+)\x00", lambda m: fences[int(m.group(1))], md)
    return md

LUA = r'''
function Image(el)
  if not el.attributes["width"] and not el.attributes["height"] then el.attributes["width"] = "6in" end
  return el
end
'''

def main():
    have = {int(re.search(r"ch(\d+)\.md$", p).group(1)) for p in chapter_files()}
    missing = sorted(set(range(0, 11)) - have)
    if missing and "test" not in os.path.basename(OUT):
        sys.exit(f"MISSING chapters {missing}; refuse to build a final doc")
    make_reference()
    md = assemble()
    lua = os.path.join(HERE, "imgwidth.lua"); open(lua, "w").write(LUA)
    pypandoc.convert_file(md, "docx", outputfile=OUT,
        extra_args=[f"--reference-doc={REF}", f"--resource-path={HERE}",
                    f"--lua-filter={lua}", "--from=markdown+tex_math_dollars+pipe_tables-implicit_figures"])
    d = Document(OUT)
    # margins
    for s in d.sections:
        s.left_margin = s.right_margin = Inches(0.9); s.top_margin = s.bottom_margin = Inches(0.8)
    # tables: full width + borders
    for t in d.tables:
        t.style = d.styles["Table"] if "Table" in [s.name for s in d.styles] else t.style
        tblPr = t._tbl.tblPr
        for tag in ("w:tblW",):
            el = tblPr.find(qn(tag))
            if el is None: el = tblPr.makeelement(qn(tag), {}); tblPr.append(el)
            el.set(qn("w:type"), "pct"); el.set(qn("w:w"), "5000")
        b = tblPr.find(qn("w:tblBorders"))
        if b is None:
            b = tblPr.makeelement(qn("w:tblBorders"), {}); tblPr.append(b)
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            e = b.find(qn("w:" + side))
            if e is None: e = b.makeelement(qn("w:" + side), {}); b.append(e)
            e.set(qn("w:val"), "single"); e.set(qn("w:sz"), "4"); e.set(qn("w:color"), "999999")
    d.save(OUT)
    import zipfile
    x = zipfile.ZipFile(OUT).read("word/document.xml").decode()
    print("OK", OUT, "omath", x.count("<m:oMath>") + x.count("<m:oMath "), "tables", len(d.tables),
          "images", x.count("<w:drawing"), "size", os.path.getsize(OUT))

if __name__ == "__main__":
    main()
