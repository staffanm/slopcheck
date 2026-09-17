import { test, expect } from '@playwright/test';
import pasted from './fixtures/pasted-line-wrap.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';

const invalidUri = 'https://lagen.nu/dom/nja/2013s372';
const validUri = 'https://lagen.nu/1915:218#P4';
const procedureUri = 'https://lagen.nu/1942:740#K18P7';
const source = '**4 §** Antagande svar, som för sent kommer anbudsgivaren till handa, skall gälla såsom nytt anbud.\n\n**5 §** En annan regel.';

async function mockApi(page, { failResolve = false, sourceText = source } = {}) {
  const requests = [];
  await page.route('https://lagen.nu/api/v1/**', async route => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    if (url.pathname.endsWith('/citations/extract')) {
      const input = request.postDataJSON();
      const blocks = input.blocks ?? [{ id: 'text', text: input.text }];
      const occurrences = blocks.flatMap(block => [...block.text.matchAll(/NJA 2013 s\. 372|4 § avtalslagen|18 kap\. 7 § rättegångsbalken/g)].map(match => ({
        text: match[0], locations: [{ block_id: block.id, start: match.index, end: match.index + match[0].length }],
        targets: [{ uri: match[0].startsWith('NJA') ? invalidUri : match[0].startsWith('18 kap.') ? procedureUri : validUri, source: match[0].startsWith('NJA') ? 'dv' : 'sfs' }],
      })));
      await route.fulfill({ json: { offset_unit: 'utf-16', occurrences } });
    } else if (url.pathname.endsWith('/resolve')) {
      if (failResolve) return route.abort('internetdisconnected');
      const uri = url.searchParams.get('q');
      await route.fulfill({ json: uri === invalidUri ? { results: [], recognized: [{ uri, invalid: true }] } : {
        results: [{ uri: uri.split('#')[0], display: 'Källa', pin: { uri, label: uri === procedureUri ? '18 kap. 7 §' : '4 §' } }], recognized: [],
      } });
    } else await route.fulfill({ json: { markdown: sourceText } });
  });
  return requests;
}

test('checks occurrences, deduplicates targets, shows source evidence, and prints all results', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  const text = '📄 I NJA 2013 s. 372 behandlas ansvar. NJA 2013 s. 372 nämns igen. Enligt 4 § avtalslagen ska ett sent svar räknas som ett nytt anbud. <img src=x onerror=alert(1)>';
  await page.getByLabel('Juridisk text').fill(text);
  await page.getByRole('button', { name: 'Kontrollera hänvisningar' }).click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.result')).toHaveCount(3);
  await expect(page.locator('.result > details > summary > .invalid')).toHaveCount(2);
  await page.locator('.result').last().locator('summary').first().click();
  await page.getByText('Visa bestämmelsen', { exact: true }).click();
  await expect(page.locator('.source-item .evidence blockquote').first()).toContainText('Antagande svar');
  await expect(page.locator('.source-item .evidence blockquote').first()).not.toContainText('En annan regel');
  await expect(page.locator('.citation-mark.selected')).toHaveText('4 § avtalslagen');
  await expect(page.locator('.document-text')).toHaveText(text);
  await expect(page.locator('.citation-mark.invalid')).toHaveCount(2);
  await expect(page.locator('.citation-mark.found')).toHaveCount(1);
  await expect(page.locator('#document-content img')).toHaveCount(0);
  expect(requests.filter(r => r.url().includes('/resolve?'))).toHaveLength(2);
  expect(requests.filter(r => r.method() === 'POST')).toHaveLength(1);
  expect(requests.find(r => r.method() === 'POST').postDataJSON()).toEqual({ text });
  await page.getByLabel('Visa', { exact: true }).selectOption('invalid');
  await expect(page.locator('.result:visible')).toHaveCount(2);
  await expect(page.locator('.citation-mark')).toHaveCount(3);
  await expect(page.locator('.document-text')).toHaveText(text);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(page.locator('.result:visible')).toHaveCount(3);
  await expect(page.locator('.result > details[open]')).toHaveCount(3);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.getByRole('button', { name: 'Rensa dokumentet' }).click();
  await expect(page.locator('#report')).toBeHidden();
  await expect(page.locator('#document-content')).toBeEmpty();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('network failure remains retryable and never becomes invalid', async ({ page }) => {
  await mockApi(page, { failResolve: true });
  await page.goto('/');
  await page.getByLabel('Juridisk text').fill('Se NJA 2013 s. 372.');
  await page.getByRole('button', { name: 'Kontrollera hänvisningar' }).click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.result > details > summary > .error')).toHaveCount(1);
  await expect(page.locator('.result .invalid')).toHaveCount(0);
  await expect(page.locator('#retry')).toBeVisible();
});

test('a DOCX is read and checked in one action, including tables and notes', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.locator('#file').setInputFiles('test/fixtures/references.docx');
  await expect(page.locator('#check')).toBeEnabled();
  expect(requests).toHaveLength(0);
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('#document-content')).toContainText('Tabelltext');
  await expect(page.locator('#document-content')).toContainText('Fotnot 1');
  await expect(page.locator('.result')).toHaveCount(3);
  expect(requests.find(r => r.method() === 'POST').postDataJSON().blocks).toHaveLength(4);
  expect(requests.filter(r => r.method() === 'POST').every(r => r.headers()['content-type'] === 'application/json')).toBe(true);
});

test('a PDF is checked in full with original page locations', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.locator('#file').setInputFiles('test/fixtures/references.pdf');
  expect(requests).toHaveLength(0);
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  const blocks = requests.find(r => r.method() === 'POST').postDataJSON().blocks;
  expect(blocks.map(block => block.id)).toEqual(['page-1', 'page-2']);
  await expect(page.locator('#document-content')).toContainText('PDF-sida 1');
  await expect(page.locator('#document-content')).toContainText('PDF-sida 2');
  await expect(page.locator('#document-content')).toContainText('NJA 2013 s. 372');
});

test('corrupt files fail without sending text and allow replacement', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await page.locator('#check').click();
  await expect(page.getByRole('alert')).toContainText('Kunde inte läsa dokumentet');
  expect(requests).toHaveLength(0);
  await page.locator('#remove-file').click();
  await expect(page.locator('#check')).toBeDisabled();
  await page.locator('#text').fill('Se NJA 2013 s. 372.');
  await expect(page.locator('#check')).toBeEnabled();
});

test('textarea and upload row share one file drop target', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  const bytes = [...await readFile('test/fixtures/references.pdf')];
  for (const selector of ['#text', '.file-row']) {
    await page.locator('#text').fill('Tidigare text.');
    const dataTransfer = await page.evaluateHandle(bytes => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'references.pdf', { type: 'application/pdf' }));
      return transfer;
    }, bytes);
    await page.locator(selector).dispatchEvent('dragenter', { dataTransfer });
    await expect(page.locator('#input')).toHaveClass(/dragging/);
    await page.locator(selector).dispatchEvent('drop', { dataTransfer });
    await expect(page.locator('#input')).not.toHaveClass(/dragging/);
    await expect(page.locator('#file-name')).toContainText('references.pdf');
    await expect(page.locator('#text')).toHaveValue('');
    await expect(page.locator('#check')).toBeEnabled();
    expect(requests).toHaveLength(0);
    await dataTransfer.dispose();
  }
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  expect(requests.find(r => r.method() === 'POST').postDataJSON().blocks).toHaveLength(2);
  await expect(page.locator('#document-content')).toContainText('PDF-sida 2');
});

test('mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('cancelling extraction preserves input and permits a new check', async ({ page }) => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('https://lagen.nu/api/v1/citations/extract', async route => {
    started();
    await gate;
    await route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Juridisk text').fill('Se NJA 2013 s. 372.');
  await page.locator('#check').click();
  await ready;
  await page.getByRole('button', { name: 'Avbryt', exact: true }).click();
  release();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.getByLabel('Juridisk text')).toHaveValue('Se NJA 2013 s. 372.');
  await expect(page.locator('#check')).toBeEnabled();
  await expect(page.locator('#report')).toBeHidden();
});

test('pasted line wraps resolve once and highlight the unchanged original citation', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  const text = `📄\n\n${pasted.text}\n\nAvslutande text utan hänvisningar.`;
  await page.getByLabel('Juridisk text').fill(text);
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.citation-mark')).toHaveCount(1);
  await expect(page.locator('.citation-mark.found')).toHaveText(pasted.originalCitation);
  expect(await page.locator('.document-text').textContent()).toBe(text);
  expect(requests.find(r => r.method() === 'POST').postDataJSON().text).toContain(pasted.normalizedCitation);
  expect(requests.filter(r => r.url().includes('/resolve?')).map(r => new URL(r.url()).searchParams.get('q'))).toEqual([pasted.target]);
  await page.locator('.citation-mark').click();
  await expect(page.locator('.result.selected')).toBeVisible();
  await expect(page.locator('.result.selected .source-item > a')).toHaveAttribute('href', pasted.target);
  expect(await page.locator('.citation-mark').evaluate(node => node.getClientRects().length)).toBeGreaterThan(1);
});

test('inline marks and the aside select each other, with next-error navigation', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Juridisk text').fill('NJA 2013 s. 372 nämns här.\n\nEnligt 4 § avtalslagen ska ett sent svar räknas som ett nytt anbud.\n\nSe NJA 2013 s. 372 igen.');
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await page.locator('.citation-mark.found').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#citation-detail-1')).toHaveClass(/selected/);
  await expect(page.locator('#citation-detail-1 > details')).toHaveAttribute('open', '');
  await expect(page.locator('.citation-mark.found')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Nästa fel' }).click();
  await expect(page.locator('#citation-detail-2')).toHaveClass(/selected/);
  await expect(page.locator('.citation-mark').last()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Föregående fel' }).click();
  await expect(page.locator('#citation-detail-0')).toHaveClass(/selected/);
  expect((await page.locator('#citation-detail-0').boundingBox()).height).toBeLessThan(200);
  await expect(page.locator('.citation-mark[data-reference]')).toHaveCount(0);
  await page.locator('#citation-detail-1 > details > summary').click();
  await expect(page.locator('.citation-mark.found')).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('model download failure abstains while source evidence remains available; retry recovers', async ({ page }) => {
  await mockApi(page);
  await page.route('**/models/**', route => route.abort());
  await page.goto('/');
  await page.locator('#text').fill('Enligt 4 § avtalslagen ska ett sent svar räknas som ett nytt anbud.');
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.citation-mark.found')).toHaveCount(1);
  await expect(page.locator('.semantic-result.abstain')).toContainText('modellen kunde inte');
  await expect(page.locator('#retry-semantic')).toBeVisible();
  await page.getByText('Visa bestämmelsen', { exact: true }).click();
  await expect(page.locator('.evidence blockquote')).toContainText('Antagande svar');
  await page.unroute('**/models/**');
  await page.locator('#retry-semantic').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('#retry-semantic')).toBeHidden();
  await expect(page.locator('.semantic-evidence')).toContainText('WASM');
});

test('only invalid or citation-list input never downloads a model', async ({ page }) => {
  const modelRequests = [];
  page.on('request', request => { if (request.url().includes('/models/')) modelRequests.push(request.url()); });
  await mockApi(page);
  await page.goto('/');
  await page.locator('#text').fill('Källförteckning\n\nNJA 2013 s. 372\n4 § avtalslagen');
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  expect(modelRequests).toHaveLength(0);
  await page.locator('#filter').selectOption('unassessed');
  await expect(page.locator('.result:visible')).toHaveCount(2);
});

test('cancel local model download, preserve source validity and retry', async ({ page }) => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await mockApi(page);
  await page.route('**/models/**', async route => { started(); await gate; await route.abort(); });
  await page.goto('/');
  await page.locator('#text').fill('Enligt 4 § avtalslagen ska ett sent svar räknas som ett nytt anbud.');
  await page.locator('#check').click();
  await ready;
  await page.locator('#cancel').click();
  release();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.citation-mark.found')).toHaveCount(1);
  await expect(page.locator('.semantic-result.abstain')).toContainText('avbröts');
  await expect(page.locator('#retry-semantic')).toBeVisible();
  await page.locator('#clear').click();
  await expect(page.locator('#document-content')).toBeEmpty();
});

test('local privacy mode extracts citations without sending document text to API', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.locator('#local-mode').check();
  await expect(page.locator('#privacy-note')).toContainText('Lokal identifiering är aktiv');
  const text = 'Enligt 4 § avtalslagen ska ett sent svar räknas som ett nytt anbud.';
  await page.locator('#text').fill(text);
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 45000 });
  await expect(page.locator('.citation-mark.found')).toHaveCount(1);
  expect(requests.filter(r => r.method() === 'POST')).toHaveLength(0);
  expect(requests.filter(r => r.url().includes('/resolve?'))).toHaveLength(1);
  await expect(page.locator('#report-meta')).toContainText('Lokal identifiering');
});


test('a supported claim shows separate source validity, original evidence, and print details', async ({ page }) => {
  await mockApi(page, { sourceText: '**4 §** Ett sent svar ska räknas som ett nytt anbud.\n\n**5 §** Annan bestämmelse.' });
  await page.goto('/');
  await page.locator('#text').fill('Ett sent svar ska räknas som ett nytt anbud. Se 4 § avtalslagen.');
  await page.locator('#check').click();
  await expect(page.locator('#progress')).toBeHidden({ timeout: 45000 });
  await expect(page.locator('.result > details > summary > .found')).toHaveCount(1);
  await expect(page.locator('.semantic-result.correct, .semantic-result.supported')).toBeVisible();
  await expect(page.locator('.decisive-evidence')).toContainText('4 § Ett sent svar');
  await expect(page.locator('.semantic-result')).toContainText('Jämfört påstående: Ett sent svar');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(page.locator('.semantic-evidence')).toHaveAttribute('open', '');
  await expect(page.locator('.semantic-evidence')).toContainText('scandi-nli-small-5c7d1ee-q8-v1');
});
