// Reads test/fixtures/legal-claims.jsonl, the legal claims in the data/*.jsonl
// pair format. Each row gets `markdown`, its source file as the client receives
// it from lagen.nu, and `occurrence` and `blocks` for the claim as written.
import { readFileSync } from 'node:fs';

export function readLegalClaims() {
  return readFileSync(new URL('./fixtures/legal-claims.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line);
    const [source] = row.sources;
    const start = row.claim.indexOf(source.citation);
    return {
      ...row,
      markdown: readFileSync(new URL(`./fixtures/legal-sources/${source.file}`, import.meta.url), 'utf8'),
      occurrence: { text: source.citation, locations: [{ block_id: 'text', start, end: start + source.citation.length }] },
      blocks: [{ id: 'text', text: row.claim }],
    };
  });
}
