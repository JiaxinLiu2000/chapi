#!/usr/bin/env python3
"""Local PDF template tool: replace text in existing templates and fill AcroForm fields.

Primary use-case: substitute text in EXISTING PDF templates (not authoring from scratch).

Subcommands:
  info <in.pdf>                          -> JSON: page count, form fields, text preview
  make-sample <out.pdf>                  -> create a tiny template with {{placeholders}}
  replace-text <in.pdf> <out.pdf> <map.json>  -> redaction-cover + reinsert replacement text
  fill-form <in.pdf> <out.pdf> <data.json>    -> fill AcroForm form fields

Dependencies: pymupdf (fitz), pypdf. Run via:
  uv run --with pymupdf --with pypdf python pdf_tool.py <cmd> ...
"""
import argparse
import json
import sys


def cmd_info(inp: str) -> None:
    import fitz

    doc = fitz.open(inp)
    text = "".join(page.get_text() for page in doc)
    fields = []
    try:
        from pypdf import PdfReader

        f = PdfReader(inp).get_fields()
        if f:
            fields = list(f.keys())
    except Exception:
        pass
    print(json.dumps({"ok": True, "pages": doc.page_count, "fields": fields, "text": text[:2000]}))
    doc.close()


def cmd_make_sample(out: str) -> None:
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Client: {{client_name}}", fontsize=12)
    page.insert_text((72, 100), "Amount: {{amount}}", fontsize=12)
    page.insert_text((72, 128), "Date: {{date}}", fontsize=12)
    doc.save(out)
    doc.close()
    print(json.dumps({"ok": True, "out": out}))


def cmd_replace_text(inp: str, out: str, map_path: str) -> None:
    import fitz

    with open(map_path, "r", encoding="utf-8") as fh:
        mapping = json.load(fh)
    doc = fitz.open(inp)
    replaced = []
    for page in doc:
        for old, new in mapping.items():
            areas = page.search_for(old)
            for rect in areas:
                page.add_redact_annot(rect, text=str(new), fontsize=11, align=0)
                replaced.append(old)
        page.apply_redactions()
    doc.save(out)
    doc.close()
    print(json.dumps({"ok": True, "out": out, "replaced": sorted(set(replaced))}))


def cmd_fill_form(inp: str, out: str, data_path: str) -> None:
    from pypdf import PdfReader, PdfWriter

    with open(data_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    reader = PdfReader(inp)
    writer = PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, data)
        except Exception:
            pass
    with open(out, "wb") as fh:
        writer.write(fh)
    print(json.dumps({"ok": True, "out": out, "fields": list(data.keys())}))


def main() -> int:
    p = argparse.ArgumentParser(description="Local PDF template tool")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("info"); s.add_argument("input")
    s = sub.add_parser("make-sample"); s.add_argument("output")
    s = sub.add_parser("replace-text"); s.add_argument("input"); s.add_argument("output"); s.add_argument("map")
    s = sub.add_parser("fill-form"); s.add_argument("input"); s.add_argument("output"); s.add_argument("data")

    args = p.parse_args()
    try:
        if args.cmd == "info":
            cmd_info(args.input)
        elif args.cmd == "make-sample":
            cmd_make_sample(args.output)
        elif args.cmd == "replace-text":
            cmd_replace_text(args.input, args.output, args.map)
        elif args.cmd == "fill-form":
            cmd_fill_form(args.input, args.output, args.data)
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
