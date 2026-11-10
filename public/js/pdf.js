// pdf.js — generador mínimo de PDF (texto, líneas, rectángulos), sin dependencias.
// Usa las fuentes estándar Helvetica / Helvetica-Bold con WinAnsiEncoding: alcanza
// para español (á, ñ, ¿…) sin embeber fuentes. Coordenadas en puntos, medidas
// desde ARRIBA de la página (y crece hacia abajo, como en pantalla).

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;

// Anchos AFM de Helvetica para ASCII 32..126, en milésimas de em.
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Fuera de Latin-1, WinAnsi (cp1252) tiene estos pocos caracteres útiles.
const CP1252 = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

const toWinAnsi = (s) => Array.from(String(s ?? ''), (ch) => {
  const c = ch.codePointAt(0);
  if (c < 0x20) return ' ';
  if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) return ch;
  if (ch === '−') return '-';
  return CP1252[ch] ? String.fromCharCode(CP1252[ch]) : '?';
}).join('');

const pdfStr = (s) => toWinAnsi(s).replace(/[\\()]/g, '\\$&');

const charWidth = (ch, bold) => {
  let c = ch.codePointAt(0);
  // Acentuadas: mismo ancho que la letra base (á = a, Ñ = N); exacto en Helvetica.
  if (c > 126) c = ch.normalize('NFD').codePointAt(0);
  return c >= 32 && c <= 126 ? (bold ? W_BOLD : W_REG)[c - 32] : 556;
};

export const textWidth = (s, size = 10, bold = false) =>
  Array.from(String(s ?? '')).reduce((w, ch) => w + charWidth(ch, bold), 0) * size / 1000;

// Recorta con "..." para que entre en `maxW` puntos.
export const fitText = (s, maxW, size = 10, bold = false) => {
  let t = String(s ?? '');
  if (textWidth(t, size, bold) <= maxW) return t;
  while (t && textWidth(t + '...', size, bold) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '...';
};

const n2 = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => (c || [0, 0, 0]).map(n2).join(' ');

export const createPdf = ({ title = '' } = {}) => {
  const pages = [];
  let ops = null;

  const doc = {
    width: PAGE_W,
    height: PAGE_H,
    addPage() { ops = []; pages.push(ops); return doc; },
    // align: 'left' | 'right' (x es el borde derecho) | 'center'
    text(x, y, str, { size = 10, bold = false, align = 'left', color } = {}) {
      const w = align === 'left' ? 0 : textWidth(str, size, bold);
      const tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${n2(tx)} ${n2(PAGE_H - y)} Tm (${pdfStr(str)}) Tj ET`);
      return doc;
    },
    line(x1, y1, x2, y2, { width = 0.5, color = [0.8, 0.8, 0.8] } = {}) {
      ops.push(`q ${rgb(color)} RG ${n2(width)} w ${n2(x1)} ${n2(PAGE_H - y1)} m ${n2(x2)} ${n2(PAGE_H - y2)} l S Q`);
      return doc;
    },
    rect(x, y, w, h, { fill = [0.95, 0.95, 0.95] } = {}) {
      ops.push(`q ${rgb(fill)} rg ${n2(x)} ${n2(PAGE_H - y - h)} ${n2(w)} ${n2(h)} re f Q`);
      return doc;
    },
    // Bytes del archivo. Todo el texto pasa por WinAnsi, así que 1 char = 1 byte
    // y los offsets del xref se pueden contar sobre el string.
    output() {
      const objs = [];
      const add = (body) => { objs.push(body); return objs.length; };
      const catalogId = add('');
      const pagesId = add('');
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids = pages.map((pageOps) => {
        const content = pageOps.join('\n');
        const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
        return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
          + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`);
      });
      objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
      objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      // El /Title va en PDFDocEncoding, que no coincide con WinAnsi en 0x80-0x9F.
      const infoId = add(`<< /Title (${pdfStr(title).replace(/[\x80-\x9F]/g, '-')}) /Producer (Tempo) >>`);

      let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
      const offsets = objs.map((body, i) => {
        const at = out.length;
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
        return at;
      });
      const xrefAt = out.length;
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
        + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`
        + `startxref\n${xrefAt}\n%%EOF\n`;

      const bytes = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
      return bytes;
    },
  };
  doc.addPage();
  return doc;
};
