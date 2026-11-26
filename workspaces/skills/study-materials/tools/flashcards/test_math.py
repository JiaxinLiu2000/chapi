"""Assert every formula renders with KaTeX in all sections (list view = every card), no katex-error, no raw delimiters left."""
import sys, time, pathlib
sys.path.insert(0, r"C:\Users\tygac\Downloads\chapi\sessions\cmwal5dvh00z2qlc87cwslmxg\sandbox")
from chapi_browser import open_page

html = pathlib.Path(__file__).with_name("CS6140_Midterm_Flashcards.html").resolve().as_uri()
out = pathlib.Path(__file__).parent
with open_page() as page:
    msgs = []
    page.on("pageerror", lambda e: msgs.append("ERR " + str(e)))
    page.on("console", lambda m: msgs.append(m.type + " " + m.text) if m.type in ("error", "warning") else None)
    page.set_viewport_size({"width": 1200, "height": 950})
    page.goto(html, wait_until="load", timeout=60000); time.sleep(1.5)
    assert page.evaluate("typeof katex !== 'undefined' && typeof renderMathInElement === 'function'"), "KaTeX not loaded"
    total_k = 0
    for tab in ("#tabCards", "#tabDeep", "#tabCalc", "#tabFig"):
        page.click(tab); time.sleep(0.3); page.click("#tabList"); time.sleep(1.2)
        page.click("#expandAll"); time.sleep(0.3)
        r = page.evaluate("""() => { const el = document.getElementById('viewList');
            return {items: el.querySelectorAll('.item').length, katex: el.querySelectorAll('.katex').length,
                    errors: el.querySelectorAll('.katex-error').length,
                    raw: (el.innerText.match(/\\\\\\(|\\\\\\)/g) || []).length}; }""")
        print(tab, r); total_k += r["katex"]
        assert r["errors"] == 0 and r["raw"] == 0, (tab, r)
    # fonts actually loaded (embedded woff2)
    fonts = page.evaluate("Array.from(document.fonts).filter(f => f.family.includes('KaTeX') && f.status === 'loaded').length")
    print("KaTeX fonts loaded:", fonts); assert fonts > 0
    # the card from the user's screenshot, in flashcard mode
    page.click("#tabCards"); time.sleep(0.3); page.fill("#search", "closed-form solution"); time.sleep(0.5)
    page.click("#card"); time.sleep(0.8); page.screenshot(path=str(out / "shot_math_logistic.png"))
    page.fill("#search", ""); page.click("#tabCalc"); time.sleep(0.3); page.fill("#search", "medical test"); time.sleep(0.5)
    page.click("#card"); time.sleep(0.8); page.screenshot(path=str(out / "shot_math_bayes.png"))
    page.fill("#search", "")
    page.evaluate("localStorage.clear()")
    print("total formulas rendered:", total_k, "| console:", msgs); assert not msgs
    print("ALL MATH ASSERTIONS PASSED")
