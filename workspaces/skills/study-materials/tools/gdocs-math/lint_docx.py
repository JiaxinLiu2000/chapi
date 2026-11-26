import zipfile, re, sys, subprocess
docx = sys.argv[1]
x = zipfile.ZipFile(docx).read("word/document.xml").decode("utf8")
ts = re.findall(r"<w:t[^>]*>([^<]*)</w:t>", x)
bad = [t for t in ts if "\\" in t or "$" in t]
print("raw-tex/dollar text runs:", len(bad))
for t in bad[:40]:
    print("  ", t[:160])
mt = re.findall(r"<m:t[^>]*>([^<]*)</m:t>", x)
badm = [t for t in mt if "\\" in t]
print("math runs with backslash:", len(badm))
for t in badm[:40]:
    print("  ", t[:160])
if len(sys.argv) > 2:
    import pypandoc
    r = subprocess.run([pypandoc.get_pandoc_path(), sys.argv[2], "-f", "markdown+tex_math_dollars+pipe_tables-implicit_figures",
                        "-t", "docx", "-o", "lint_tmp.docx", "--verbose"], capture_output=True, text=True, encoding="utf8")
    w = [l for l in r.stderr.splitlines() if "WARN" in l or "Could not" in l]
    print("pandoc warnings:", len(w))
    for l in w[:40]:
        print("  ", l[:200])
