// pdfText — pure-JS PDF text extraction for the AI-extraction tier (HANDOFF 1.5).
//
// The .NET reference engine used PdfPig's content-order text extractor to get
// label:value text lines out of the order PDFs before running the Rx* regexes.
// This is the Node equivalent: unpdf (a serverless build of Mozilla pdf.js, zero
// runtime deps, no native bindings — safe in a Vercel function) plus a
// content-order line reconstruction. The DynamicPDF/Kinnser order documents emit
// their text cell-by-cell in the content stream, so walking items in content
// order (breaking lines on hasEOL / baseline changes) yields "label" on one line
// and "value" on the next — exactly the shape the extraction regexes expect.
// A visual-line (sort-by-Y) reconstruction was tried first and rejected: it
// merges the CMS-485 grid columns into single lines, splitting labels from values.
//
// Only TEXT-BASED PDFs are supported (the DynamicPDF/Kinnser order documents are;
// scanned PDFs would need OCR, which the POC does not do — Tier 2 Gemini is the
// fallback for those).

import { getDocumentProxy } from 'unpdf';

// Items whose baselines are within this many PDF units are the same text line
// (handles superscripts / slight baseline drift within a cell).
const LINE_TOLERANCE = 3;

// Reconstruct one page's text from pdf.js text items in CONTENT ORDER.
// New line when the item declares hasEOL or the baseline (Y) moves; a space is
// inserted at same-line X jumps (adjacent grid cells sharing a baseline).
function pageText(items) {
  let text = '';
  let prevY = null;
  let prevEndX = null;
  for (const item of items) {
    const str = typeof item.str === 'string' ? item.str : '';
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    if (str) {
      if (typeof y === 'number' && prevY !== null && Math.abs(y - prevY) > LINE_TOLERANCE) {
        if (!text.endsWith('\n')) text += '\n';
      } else if (
        typeof x === 'number' && prevEndX !== null &&
        (x < prevEndX - 1 || x > prevEndX + 2) &&
        text && !text.endsWith('\n') && !text.endsWith(' ')
      ) {
        text += ' '; // column gap / backward jump on the same baseline
      }
      text += str;
      if (typeof y === 'number') prevY = y;
      if (typeof x === 'number') prevEndX = x + (typeof item.width === 'number' ? item.width : 0);
    }
    if (item.hasEOL && !text.endsWith('\n')) {
      text += '\n';
      prevEndX = null;
    }
  }
  return text;
}

// Normalize extracted text so the PATTERNS regexes see a consistent corpus:
// straight quotes, single spaces, trimmed lines, but LINE STRUCTURE KEPT —
// the label:value patterns rely on newlines to bound captured values.
export function normalizePdfText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * extractPdfText — extract normalized, line-structured text from a PDF buffer.
 * Multi-page: pages are concatenated with a blank line between them.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer raw PDF bytes
 * @returns {Promise<string>} normalized text ('' when the buffer is empty/unreadable)
 */
export async function extractPdfText(buffer) {
  if (!buffer) return '';
  const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer);
  if (!bytes.length) return '';
  const pdf = await getDocumentProxy(bytes);
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      page.cleanup?.();
    }
    return normalizePdfText(pages.join('\n\n'));
  } finally {
    await pdf.destroy?.();
  }
}
