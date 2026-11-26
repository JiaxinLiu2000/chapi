"""Render a page range of a PDF to PNG images (for phone previews).

usage: python -I render_pdf_pages.py <pdf> <out_dir> <first_page_1based> <count> [max_width_px]
prints JSON: {"pages": <total>, "images": ["<png path>", ...]}
"""
import json
import os
import sys

import pymupdf


def main() -> None:
    pdf, out_dir, first, count = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    max_w = int(sys.argv[5]) if len(sys.argv) > 5 else 1400
    os.makedirs(out_dir, exist_ok=True)
    doc = pymupdf.open(pdf)
    total = doc.page_count
    images = []
    stem = os.path.splitext(os.path.basename(pdf))[0]
    for i in range(max(first, 1) - 1, min(total, first - 1 + count)):
        page = doc[i]
        # ~150 dpi, capped so wide sheets stay a sane size on a phone
        zoom = min(150 / 72, max_w / max(page.rect.width, 1))
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        path = os.path.join(out_dir, f"{stem}-p{i + 1}.png")
        pix.save(path)
        images.append(path)
    print(json.dumps({"pages": total, "images": images}, ensure_ascii=False))


if __name__ == "__main__":
    main()
