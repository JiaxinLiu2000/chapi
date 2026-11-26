// Render TeX formulas to PNG with MathJax (SVG, paths only) + resvg.
// Input: jobs.json = [{id, tex, display}] ; Output: out/<id>.png and meta.json {id: {w_ex, h_ex, v_ex, px_w, px_h}}
const fs = require('fs');
const path = require('path');
const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');
const { Resvg } = require('@resvg/resvg-js');

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: 'none' });
const doc = mathjax.document('', { InputJax: tex, OutputJax: svg });

const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
const PX_PER_EX = 15; // render resolution
const meta = {};
let errors = 0;
for (const j of jobs) {
  try {
    const node = doc.convert(j.tex, { display: j.display, em: 16, ex: 8, containerWidth: 80 * 16 });
    let s = adaptor.innerHTML(node);
    if (/data-mjx-error|merror/.test(s)) { errors++; console.error('TeX error', j.id, j.tex.slice(0, 120)); }
    const m = s.match(/width="([\d.]+)ex" height="([\d.]+)ex"/);
    const va = s.match(/vertical-align:\s*(-?[\d.]+)ex/);
    const wEx = parseFloat(m[1]), hEx = parseFloat(m[2]);
    const pxW = Math.round(wEx * PX_PER_EX), pxH = Math.round(hEx * PX_PER_EX);
    s = s.replace(/width="[\d.]+ex" height="[\d.]+ex"/, `width="${pxW}" height="${pxH}"`);
    if (!s.includes('xmlns=')) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    const r = new Resvg(s, { background: 'white', fitTo: { mode: 'width', value: pxW },
                            font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' } });
    fs.writeFileSync(path.join(outDir, j.id + '.png'), r.render().asPng());
    meta[j.id] = { w_ex: wEx, h_ex: hEx, v_ex: va ? parseFloat(va[1]) : 0 };
  } catch (e) { errors++; console.error('FAIL', j.id, e.message); }
}
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta));
console.log('rendered', Object.keys(meta).length, 'errors', errors);
