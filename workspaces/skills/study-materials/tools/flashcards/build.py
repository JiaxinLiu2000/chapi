"""Concatenate card data + embedded images + embedded KaTeX into the template -> single self-contained HTML (works offline)."""
import pathlib, json, re, base64
here = pathlib.Path(__file__).parent
kx = here / "katex_dl" / "package" / "dist"
cards = "\n".join((here / f"cards_{i}.js").read_text(encoding="utf-8") for i in range(1, 8))
imgs = json.loads((here / "imgs.json").read_text())

css = (kx / "katex.min.css").read_text(encoding="utf-8")
def font_uri(m):
    data = base64.b64encode((kx / "fonts" / m.group(1)).read_bytes()).decode()
    return f'url(data:font/woff2;base64,{data}) format("woff2")'
css = re.sub(r'url\(fonts/([\w-]+\.woff2)\) format\("woff2"\)', font_uri, css)
css = re.sub(r',url\(fonts/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)', "", css)
assert "fonts/" not in css, "unembedded font reference left"
js = (kx / "katex.min.js").read_text(encoding="utf-8") + "\n" + (kx / "contrib" / "auto-render.min.js").read_text(encoding="utf-8")

html = (here / "template.html").read_text(encoding="utf-8")
html = html.replace("/*KATEX_CSS*/", css).replace("/*KATEX_JS*/", js.replace("</script", "<\\/script"))
html = html.replace("/*IMGS*/", "const IMGS = " + json.dumps(imgs, separators=(",", ":")) + ";").replace("/*CARDS*/", cards)
out = here / "CS6140_Midterm_Flashcards.html"
out.write_text(html, encoding="utf-8")
print(out, round(len(html) / 1e6, 2), "MB")
