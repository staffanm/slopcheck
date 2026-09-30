#!/usr/bin/env node
// Writes the input for model claim extraction: one file per thesis with
// numbered sentences per PDF page ("[page.n] text"), footnotes inlined by
// pdfPageText. The body runs from the first page with an inlined note to the
// bibliography. A note that the segmenter put at the start of the next
// sentence ("… konsumeras. (Note.) Det här …") is moved back to the sentence
// it follows.
//
// Usage: node scripts/thesis-sentences.mjs <pdf-dir> <docs.txt> <out-dir> [shard/shards]
// Line N of docs.txt is written to <out-dir>/docN.txt; existing files are skipped.
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfPageText, sentenceSegments } from '../src/analysis.js';

const [dir, list, out, shardArg = '0/1'] = process.argv.slice(2);
const [shard, shards] = shardArg.split('/').map(Number);
const BIBLIOGRAPHY = /(?:^|\n)\s*(?:\d+\.?\s*)?(?:Käll-\s*och\s*litteraturförteckning|Käll-\s*och\s*referensförteckning|Källförteckning|Källor|Litteraturförteckning|Referenser|Referenslista|Bibliografi)(?:\s|$)/i;

const names = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean);
for (const [index, name] of names.entries()) {
  const file = `${out}/doc${index + 1}.txt`;
  if (index % shards !== shard || fs.existsSync(file)) continue;
  try {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(`${dir}/${name}`)), verbosity: 0 }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) pages.push(pdfPageText((await (await pdf.getPage(n)).getTextContent()).items));
    await pdf.cleanup();
    const end = pages.findIndex((text, i) => i >= pages.length * 0.4 && BIBLIOGRAPHY.test(text));
    const last = end < 0 ? pages.length : end;
    const first = Math.max(0, pages.findIndex(text => /[.!?”"]\s*\([^()]{3,}\)/.test(text)));
    const lines = [`# ${name}`, ''];
    for (let p = first; p < last; p++) {
      const merged = [];
      for (const segment of sentenceSegments(pages[p]).map(s => s.segment.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
        const lead = /^\((?:[^()]|\([^()]*\))*\)/.exec(segment);
        if (lead && merged.length) {
          merged[merged.length - 1] += ` ${lead[0]}`;
          const rest = segment.slice(lead[0].length).trim();
          if (rest) merged.push(rest);
        } else merged.push(segment);
      }
      lines.push(`## page ${p + 1}`, ...merged.map((segment, i) => `[${p + 1}.${i + 1}] ${segment}`), '');
    }
    fs.writeFileSync(file, lines.join('\n'));
    console.error(`doc${index + 1} pages ${first + 1}-${last} ${name}`);
  } catch (error) {
    console.error(`FAIL doc${index + 1} ${name}: ${error.message}`);
  }
}
