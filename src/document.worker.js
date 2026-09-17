import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth/mammoth.browser.js';
import { pdfPageText, selectEvidence, validateBlocks } from './analysis.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function readPdf(buffer) {
  const task = pdfjs.getDocument({ data: buffer, isEvalSupported: false, useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const labels = await pdf.getPageLabels();
    const blocks = [];
    const warnings = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = pdfPageText((await page.getTextContent()).items);
      if (text.replace(/\s/g, '').length < 40) warnings.push(`PDF-sida ${pageNumber} har lite eller ingen läsbar text. Kontrollera om sidan behöver OCR.`);
      blocks.push({ id: `page-${pageNumber}`, label: `PDF-sida ${pageNumber}${labels ? ` (${labels[pageNumber - 1]})` : ''}`, text });
      self.postMessage({ type: 'progress', message: `Läser PDF-sida ${pageNumber} av ${pdf.numPages}` });
      page.cleanup();
      if (blocks.some(block => block.text.trim())) validateBlocks(blocks);
    }
    return { blocks, warnings };
  } finally {
    await task.destroy();
  }
}

self.onmessage = async ({ data }) => {
  // This boundary returns a recoverable file/source error to the UI. It keeps
  // completed results available, and never turns a failure into invalidity.
  try {
    let result;
    if (data.type === 'pdf') result = await readPdf(data.buffer);
    else if (data.type === 'docx') {
      const converted = await mammoth.convertToHtml({ arrayBuffer: data.buffer }, {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      });
      result = { html: converted.value, warnings: converted.messages.length ? ['Word-filen innehåller formatering som inte kunde läsas fullständigt. Kontrollera dokumenttexten i rapporten.'] : [] };
    } else if (data.type === 'evidence') result = selectEvidence(data.markdown, data.uri, data.claim, data.anchors);
    else throw new Error('Okänd dokumentåtgärd.');
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
