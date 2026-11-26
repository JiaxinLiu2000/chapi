# -*- coding: utf-8 -*-
"""Fix a python-docx table to an explicit total width (one text column) with content-weighted column widths.
Google Docs ignores Word's autofit and uses tblW/gridCol/tcW, so all three are written explicitly."""
import re
from docx.shared import Inches
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def _vis_len(s):
    s = re.sub(r"\*\*", "", s)
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in s)

def fit_table(t, rows, total_in=3.55):
    ncol = len(t.columns)
    # weight = blend of longest cell (capped) and average cell, so one long cell doesn't starve the others
    w = []
    for j in range(ncol):
        lens = [_vis_len(str(r[j])) if j < len(r) else 0 for r in rows]
        w.append(0.55 * min(max(lens), 60) + 0.45 * (sum(lens) / len(lens)) + 4)
    tot = sum(w); minw = 0.45 if ncol <= 4 else 0.35
    widths = [max(minw, total_in * x / tot) for x in w]
    scale = total_in / sum(widths); widths = [x * scale for x in widths]
    tw = [int(x * 1440) for x in widths]
    t.autofit = False
    tblPr = t._tbl.tblPr
    for tag in ("w:tblW", "w:tblLayout"):
        for e in tblPr.findall(qn(tag)): tblPr.remove(e)
    tblW = OxmlElement("w:tblW"); tblW.set(qn("w:w"), str(sum(tw))); tblW.set(qn("w:type"), "dxa"); tblPr.append(tblW)
    lay = OxmlElement("w:tblLayout"); lay.set(qn("w:type"), "fixed"); tblPr.append(lay)
    grid = t._tbl.tblGrid
    for gc, x in zip(grid.findall(qn("w:gridCol")), tw): gc.set(qn("w:w"), str(x))
    for row in t.rows:
        for j, cell in enumerate(row.cells):
            cell.width = Inches(widths[j])
    return widths
