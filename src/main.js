import './style.css';
import { extract, getDocumentSource, pool, prefetchCorePack, request, resolveTarget, resolveTargetPrivate, stopExtractionWorker } from './api.js';
import { claimContext, claimSegments, invalidCitationMessage, mergeOccurrences, occurrenceStatus, validateBlocks } from './analysis.js';
import { matchesFilter, rowSemantic, SEMANTIC, semanticClaim } from './semantic.js';
import { semanticClient } from './semantic-client.js';
import { matchClaimRemote } from './api.js';

const $ = selector => document.querySelector(selector);
const STATUS = {
  found: ['✓', 'Hittad källa'], invalid: ['×', 'Ogiltig hänvisning'],
  unconfirmed: ['?', 'Obekräftad'], error: ['!', 'Kunde inte kontrolleras'], pending: ['○', 'Kontrollerar'],
};
let blocks = [];
let checkedBlocks = [];
let rows = [];
let targets = new Map();
let sourceCache = new Map();
let controller;
let fileController;
let selectedFile;
let worker;
let jobId = 0;
const jobs = new Map();
let reportName = '';
let reportDate = '';
let selectedRow = null;
let documentMarks = [];
const semantics = semanticClient(progress);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function work(type, data) {
  if (!worker) {
    worker = new Worker(new URL('./document.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: message }) => {
      if (message.type === 'progress') return progress(message.message);
      const job = jobs.get(message.id);
      if (!job) return;
      jobs.delete(message.id);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.result);
    };
    worker.onerror = () => stopWorker(new Error('Dokumentläsaren kunde inte starta. Ladda om sidan och försök igen.'));
  }
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...data }, data.buffer ? [data.buffer] : []);
  });
}

function stopWorker(reason = new DOMException('Avbruten', 'AbortError')) {
  worker?.terminate();
  worker = undefined;
  for (const job of jobs.values()) job.reject(reason);
  jobs.clear();
}

function setProgress(fraction, message) {
  $('#progress').hidden = false;
  if (message !== undefined) $('#progress-label').textContent = message;
  const bar = $('#progress-bar');
  if (fraction == null) {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }
}

// The semantic worker reports model-download progress as a fraction.
function progress(message, fraction) {
  setProgress(fraction ?? null, message);
}

function busy(active) {
  $('#progress').hidden = !active;
  for (const selector of ['#file', '#remove-file', '#local-mode', '#check', '#retry', '#retry-semantic', '#clear', '#print']) {
    $(selector).disabled = active;
  }
  // A loaded file keeps the textarea disabled: it shows the received content.
  $('#text').disabled = active || Boolean(selectedFile);
  if (!active) {
    $('#check').disabled = !blocks.length && !selectedFile;
    controller = undefined;
  }
}

function displayError(error) {
  $('#error').textContent = error.name === 'TimeoutError'
    ? 'lagen.nu svarar inte inom två minuter. Texten finns kvar. Försök igen.'
    : error instanceof TypeError ? 'Kunde inte ansluta till lagen.nu. Kontrollera anslutningen och försök igen.' : error.message;
  $('#error').hidden = false;
}

function warnings(messages) {
  $('#warnings').replaceChildren(...messages.map(message => element('p', '', message)));
  $('#warnings').hidden = !messages.length;
}

function resetReport() {
  semantics.stop();
  rows = [];
  checkedBlocks = [];
  targets.clear();
  sourceCache.clear();
  $('#report').hidden = true;
  $('#results').replaceChildren();
  $('#document-content').replaceChildren();
  documentMarks = [];
  selectedRow = null;
  $('#summary').replaceChildren();
  $('#error').hidden = true;
}

function clearFile() {
  fileController?.abort();
  fileController = undefined;
  selectedFile = undefined;
  $('#file').value = '';
  $('#file-name').textContent = 'eller dra filen till textfältet · högst 25 MB';
  $('#remove-file').hidden = true;
  $('#text').disabled = false;
}

$('#text').addEventListener('input', () => {
  resetReport();
  clearFile();
  blocks = $('#text').value.trim() ? [{ id: 'text', label: 'Inklistrad text', text: $('#text').value }] : [];
  $('#character-count').textContent = `${[...$('#text').value].length.toLocaleString('sv')} / 250 000 tecken`;
  $('#check').disabled = !blocks.length;
  warnings([]);
});

async function chooseFile(file) {
  if (!file || controller || fileController) return;
  if (!/\.(pdf|docx)$/i.test(file.name)) return displayError(new Error('Välj en PDF- eller DOCX-fil. Äldre DOC-filer stöds inte.'));
  if (file.size > 25 * 1024 * 1024) return displayError(new Error('Filen är större än 25 MB. Välj en mindre fil.'));
  resetReport();
  blocks = [];
  selectedFile = file;
  $('#text').value = '';
  $('#text').disabled = true;
  $('#file-name').textContent = `${file.name} · ${(file.size / 1024 / 1024).toLocaleString('sv', { maximumFractionDigits: 1 })} MB`;
  $('#remove-file').hidden = false;
  $('#check').disabled = true;
  $('#input-wrap').open = true;
  $('#error').hidden = true;
  warnings([]);
  fileController = new AbortController();
  const signal = fileController.signal;
  try {
    setProgress(null, 'Läser dokumentet på din enhet…');
    await readSelectedFile(signal);
    signal.throwIfAborted();
    // Show the received content so the user sees the file was read.
    $('#text').value = blocks.map(block => block.text).join('\n\n');
    $('#character-count').textContent = `${[...$('#text').value].length.toLocaleString('sv')} tecken lästa ur filen`;
    $('#check').disabled = !blocks.length;
  } catch (error) {
    if (error.name !== 'AbortError') { displayError(error); clearFile(); $('#text').value = ''; }
  } finally {
    if (fileController?.signal === signal) fileController = undefined;
    $('#progress').hidden = true;
  }
}

$('#file').addEventListener('change', event => chooseFile(event.target.files[0]));
$('#remove-file').addEventListener('click', () => {
  clearFile();
  $('#text').value = '';
  $('#text').dispatchEvent(new Event('input'));
  $('#text').focus();
});
for (const eventName of ['dragover', 'dragenter']) $('#input').addEventListener(eventName, event => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = controller ? 'none' : 'copy';
  if (!controller) $('#input').classList.add('dragging');
});
$('#input').addEventListener('dragleave', event => {
  if (!$('#input').contains(event.relatedTarget)) $('#input').classList.remove('dragging');
});
$('#input').addEventListener('drop', event => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  $('#input').classList.remove('dragging');
  if (controller) return;
  if (event.dataTransfer.files.length !== 1) return displayError(new Error('Välj en fil åt gången.'));
  chooseFile(event.dataTransfer.files[0]);
});

function docxBlocks(html) {
  // Template contents are inert. Never insert converted HTML into the page.
  const template = document.createElement('template');
  template.innerHTML = html;
  const content = template.content;
  // Move each footnote or endnote inline where its marker sits, so a citation
  // in a note is found and given context exactly like an inline citation.
  const noteText = id => {
    const item = content.querySelector(`li[id="${id}"]`);
    if (!item) return '';
    const clone = item.cloneNode(true);
    clone.querySelectorAll('a[href^="#footnote-ref"],a[href^="#endnote-ref"]').forEach(link => link.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  };
  for (const marker of content.querySelectorAll('a[id^="footnote-ref-"],a[id^="endnote-ref-"]')) {
    const text = noteText((marker.getAttribute('href') ?? '').replace(/^#/, ''));
    const target = marker.closest('sup') ?? marker;
    if (text) target.replaceWith(document.createTextNode(` (${text})`));
    else target.remove();
  }
  content.querySelectorAll('li[id^="footnote-"],li[id^="endnote-"]').forEach(item => item.remove());
  content.querySelectorAll('ol,ul').forEach(list => { if (!list.querySelector('li')) list.remove(); });

  return [...content.querySelectorAll('p,h1,h2,h3,h4,h5,h6')].map((node, index) => (
    { id: `paragraph-${index + 1}`, label: `Stycke ${index + 1}`, text: node.textContent.trim() }
  )).filter(block => block.text);
}

async function readSelectedFile(signal) {
  progress('Läser dokumentet på din enhet…');
  try {
    const buffer = await selectedFile.arrayBuffer();
    signal.throwIfAborted();
    const pdf = /\.pdf$/i.test(selectedFile.name);
    const result = await work(pdf ? 'pdf' : 'docx', { buffer });
    signal.throwIfAborted();
    const extracted = pdf ? result.blocks : docxBlocks(result.html);
    validateBlocks(extracted);
    blocks = extracted;
    warnings(result.warnings);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`Kunde inte läsa dokumentet. ${error.message}`);
  }
}

function sourceLink(uri, label) {
  const url = new URL(uri);
  if (url.origin !== 'https://lagen.nu') return element('span', '', label);
  const link = element('a', '', `${label} ↗`);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function badge(status) {
  return element('span', `badge ${status}`, STATUS[status].join(' '));
}

function passageLabel(passage) {
  return [passage.court, passage.section].filter(Boolean).join(' · ');
}

function renderSource(target, evidence, multiple, row) {
  const section = element('section', 'source-item');
  if (multiple) {
    section.append(badge(target.status));
    if (target.status !== 'found') section.append(element('p', 'source-note', target.uri));
  }
  if (target.status !== 'found') {
    section.append(element('p', 'source-note', {
      invalid: invalidCitationMessage(target, row.occurrence),
      unconfirmed: 'lagen.nu kan inte bekräfta källan.',
      pending: 'Kontrollen pågår.', error: target.error,
    }[target.status]));
    return section;
  }
  section.append(sourceLink(target.result.pin?.uri ?? target.result.uri, target.result.pin?.label ?? target.result.display ?? target.result.identifier ?? target.uri));
  const result = row.semantic.get(target.uri);
  if (result) {
    const review = element('div', `semantic-result ${result.status}${result.status === 'correct' ? ' supported' : ''}${result.status === 'incorrect' ? ' contradiction' : ''}`);
    review.append(element('strong', '', `${SEMANTIC[result.status][0]} · experimentellt`));
    if (result.status !== 'pending') {
      review.append(element('p', 'source-note', result.reason));
      if (result.comparisons?.length) {
        const detail = element('details', 'semantic-evidence');
        detail.append(element('summary', '', 'Visa påstående och jämförelse'));
        detail.append(element('p', 'source-note', 'Påståendet som jämfördes'));
        if (row.claim.authority) detail.append(element('p', 'source-note', `Tillskrivet ${row.claim.authority}`));
        detail.append(element('blockquote', '', row.claim.hypothesis));
        // A substantive label always exposes its decisive evidence in the open card.
        if (result.status !== 'abstain') {
          if (passageLabel(result.evidence)) review.append(element('p', 'source-note', passageLabel(result.evidence)));
          review.append(element('blockquote', 'decisive-evidence', result.evidence.text));
          review.append(element('p', 'source-note', `Jämfört påstående: ${row.claim.hypothesis}`));
        }
        for (const item of result.comparisons) {
          if (passageLabel(item)) detail.append(element('p', 'source-note', passageLabel(item)));
          detail.append(element('blockquote', '', item.text));
        }
        detail.append(element('p', 'source-note', `${result.comparisons.length} avsnitt · ${result.backend} · ${result.model}`));
        review.append(detail);
      }
    }
    section.append(review);
  }
  if (target.sourceError) section.append(element('p', 'source-note', `Källtexten kunde inte hämtas: ${target.sourceError}`));
  else if (!evidence) section.append(element('p', 'source-note', 'Hämtar källtext…'));
  else {
    if (evidence.quote) section.append(element('p', 'source-note', 'Citerade ord finns i källtexten.'));
    if (!evidence.passages.length) section.append(element('p', 'source-note', evidence.reason ?? 'Källan saknar läsbar text.'));
    else {
      const passages = element('details', 'evidence');
      passages.append(element('summary', '', evidence.exact ? 'Visa bestämmelsen' : 'Visa utvalda källavsnitt'));
      if (!evidence.exact) passages.append(element('p', 'source-note', evidence.scope ?? 'Avsnitt ur hela källan; den exakta bestämmelsen kunde inte avgränsas.'));
      evidence.passages.forEach(passage => {
        if (passageLabel(passage)) passages.append(element('p', 'source-note', passageLabel(passage)));
        passages.append(element('blockquote', '', passage.text));
      });
      section.append(passages);
    }
    if (evidence.excluded?.length) {
      const excluded = element('details', 'reported-evidence');
      excluded.append(element('summary', '', 'Andra instanser och återgivna uppgifter'));
      excluded.append(element('p', 'source-note', 'Dessa avsnitt används inte som stöd för den bedömande domstolens slutsats.'));
      evidence.excluded.forEach(passage => {
        excluded.append(element('p', 'source-note', passageLabel(passage)));
        excluded.append(element('blockquote', '', passage.text));
      });
      section.append(excluded);
    }
  }
  return section;
}

function makeRow(row, index) {
  const node = $('#result-template').content.firstElementChild.cloneNode(true);
  node.dataset.row = String(index);
  node.id = `citation-detail-${index}`;
  node.querySelector('summary').addEventListener('click', event => {
    event.preventDefault();
    selectRow(index, { scrollDocument: true });
  });
  node.querySelector('.result-title strong').textContent = row.occurrence.text;
  node.querySelector('.result-title small').textContent = row.occurrence.locations.map(location => checkedBlocks.find(block => block.id === location.block_id).label).join(' · ');
  node.querySelector('.result-title small').hidden = row.occurrence.locations.every(location => location.block_id === 'text');
  return node;
}

function rowStatus(index) {
  return occurrenceStatus(rows[index].occurrence.targets.map(target => targets.get(target.uri)));
}

function showDocument() {
  documentMarks = [];
  $('#document-content').replaceChildren(...checkedBlocks.map(block => {
    const article = element('article', 'document-block');
    article.append(element('h4', '', block.label));
    const text = element('div', 'document-text');
    // Mark both the claim sentence and the citation inside it.
    for (const segment of claimSegments(block, rows)) {
      const content = block.text.slice(segment.start, segment.end);
      if (!segment.claimRows.length && !segment.citeRows.length) { text.append(document.createTextNode(content)); continue; }
      const isCite = segment.citeRows.length > 0;
      const rowsFor = isCite ? segment.citeRows : segment.claimRows;
      const mark = element('span', isCite ? 'citation-mark' : 'claim-mark', content);
      mark.setAttribute('role', 'button');
      mark.tabIndex = 0;
      mark.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); mark.click(); }
      });
      mark.setAttribute('aria-controls', rowsFor.map(index => `citation-detail-${index}`).join(' '));
      mark.addEventListener('click', () => selectRow(rowsFor.find(index => rowStatus(index) === 'invalid') ?? rowsFor[0], { focusAside: true }));
      documentMarks.push({ node: mark, claimRows: segment.claimRows, citeRows: segment.citeRows, rows: rowsFor, blockId: block.id, isCite });
      text.append(mark);
    }
    article.append(text);
    return article;
  }));
}

// Pick the most severe semantic status among the rows a mark covers.
const SEM_SEVERITY = ['incorrect', 'contradiction', 'misleading', 'missing', 'nonsensical', 'abstain', 'pending', 'correct', 'supported'];
function worstSemantic(indices) {
  let best = 'pending';
  let rank = Infinity;
  for (const index of indices) {
    const rank2 = SEM_SEVERITY.indexOf(rowSemantic(rows[index]));
    if (rank2 >= 0 && rank2 < rank) { rank = rank2; best = rowSemantic(rows[index]); }
  }
  return best;
}

function updateMarks() {
  for (const mark of documentMarks) {
    const semIndices = mark.claimRows.length ? mark.claimRows : mark.rows;
    const sem = worstSemantic(semIndices);
    const active = mark.rows.includes(selectedRow) || mark.claimRows.includes(selectedRow);
    if (mark.isCite) {
      const status = occurrenceStatus(mark.citeRows.map(index => ({ status: rowStatus(index) })));
      const tint = status === 'invalid' ? '' : ` tint-${sem}`;
      const claimLabel = status === 'invalid' ? '' : SEMANTIC[sem]?.[0];
      mark.node.className = `citation-mark ${status}${tint}${active ? ' selected' : ''}`;
      mark.node.setAttribute('aria-label', `Hänvisning: ${mark.node.textContent}. ${STATUS[status][1]}.${claimLabel ? ` Påstående: ${claimLabel} (experimentellt).` : ''} Visa detaljer.`);
      mark.node.title = status === 'invalid' ? STATUS[status][1] : `${STATUS[status][1]} · ${claimLabel} (experimentellt)`;
    } else {
      const label = SEMANTIC[sem]?.[0] ?? '';
      mark.node.className = `claim-mark tint-${sem}${active ? ' selected' : ''}`;
      mark.node.setAttribute('aria-label', `Påstående: ${label} (experimentellt). Visa detaljer.`);
      mark.node.title = `Påstående: ${label} (experimentellt)`;
    }
    mark.node.setAttribute('aria-pressed', String(active));
  }
}

function selectRow(index, { scrollDocument = false, focusAside = false } = {}) {
  selectedRow = index;
  if (!matchesFilter($('#filter').value, rowStatus(index), rowSemantic(rows[index]))) $('#filter').value = 'all';
  updateReport();
  for (const node of $('#results').querySelectorAll('[data-row]')) {
    const active = Number(node.dataset.row) === index;
    node.classList.toggle('selected', active);
    node.querySelector('details').open = active;
  }
  const node = $(`#citation-detail-${index}`);
  const aside = $('.review-aside');
  aside.scrollTop += node.getBoundingClientRect().top - aside.getBoundingClientRect().top - $('.aside-toolbar').offsetHeight;
  if (focusAside) {
    node.querySelector('summary').focus({ preventScroll: true });
    aside.scrollIntoView({ block: 'nearest' });
  }
  if (scrollDocument) {
    const mark = documentMarks.find(mark => mark.rows.includes(index)).node;
    mark.scrollIntoView({ block: 'center' });
  }
}

function nextError(direction) {
  const errors = rows.map((_, index) => index).filter(index => rowStatus(index) === 'invalid');
  if (!errors.length) return;
  const index = direction > 0
    ? errors.find(index => selectedRow === null || index > selectedRow) ?? errors[0]
    : errors.findLast(index => selectedRow === null || index < selectedRow) ?? errors.at(-1);
  selectRow(index, { scrollDocument: true });
}

$('#previous-error').addEventListener('click', () => nextError(-1));
$('#next-error').addEventListener('click', () => nextError(1));

function updateReport() {
  let visible = 0;
  const counts = { found: 0, invalid: 0, unconfirmed: 0, pending: 0, error: 0 };
  rows.forEach((row, index) => {
    const node = $(`[data-row="${index}"]`);
    const rowTargets = row.occurrence.targets.map(target => targets.get(target.uri));
    const status = occurrenceStatus(rowTargets);
    counts[status]++;
    const citeBadge = node.querySelector('.badge.cite');
    citeBadge.className = `badge cite ${status}${status === 'pending' ? ' working' : ''}`;
    citeBadge.textContent = status === 'pending' ? 'Kontrollerar' : STATUS[status][1];
    const filter = $('#filter').value;
    const semantic = rowSemantic(row);
    const semBadge = node.querySelector('.badge.sem');
    const claimLine = node.querySelector('.claim-line');
    claimLine.replaceChildren();
    if (status === 'invalid') {
      semBadge.hidden = true;
    } else {
      semBadge.hidden = false;
      const working = semantic === 'pending';
      semBadge.className = `badge sem ${semantic}${working ? ' working' : ''}`;
      semBadge.textContent = working ? 'Bedömer…' : SEMANTIC[semantic][0];
      if (row.claim?.hypothesis) claimLine.append(element('span', 'claim-label', 'Påstående:'), element('span', 'claim-text', row.claim.hypothesis));
      else claimLine.append(element('span', 'claim-label', row.claim?.reason ?? 'Inget avgränsat påstående kunde skiljas ut.'));
    }
    node.hidden = !matchesFilter(filter, status, semantic);
    if (!node.hidden) visible++;
    // Leave expanded source passages alone unless their data changed.
    const revision = rowTargets.map(target => `${target.uri}:${target.revision}`).join('|') + `:${row.evidence.size}:${row.semanticRevision}`;
    if (node.dataset.revision !== revision) {
      node.dataset.revision = revision;
      node.querySelector('.source-list').replaceChildren(...rowTargets.map(target => renderSource(target, row.evidence.get(target.uri), rowTargets.length > 1, row)));
      if (!rowTargets.length) node.querySelector('.source-list').append(element('p', 'source-note', 'Hänvisningen kunde inte kopplas till en källa.'));
    }
  });
  const validRows = rows.filter((row, index) => rowStatus(index) !== 'invalid');
  $('#summary').replaceChildren(...[[rows.length, 'Hänvisningar'], [counts.invalid, 'Ogiltiga hänvisningar'], [counts.found, 'Hittade källor'], [counts.unconfirmed + counts.error + counts.pending, 'Obekräftade / ej klara'], [validRows.filter(row => matchesFilter('review', '', rowSemantic(row))).length, 'Påståenden att granska'], [validRows.filter(row => matchesFilter('unassessed', '', rowSemantic(row))).length, 'Påståenden ej bedömda']].map(([count, label]) => {
    const cell = element('div');
    cell.append(element('strong', '', count), element('span', '', label));
    return cell;
  }));
  $('#result-count').textContent = `${visible} av ${rows.length} hänvisningar`;
  $('#retry').hidden = ![...targets.values()].some(target => target.status === 'error' || target.sourceError);
  $('#retry-semantic').hidden = !rows.some(row => [...row.semantic.values()].some(result => result.retryable));
  $('#previous-error').disabled = $('#next-error').disabled = !counts.invalid;
  updateMarks();
  $('#results .empty')?.remove();
  if (!visible) $('#results').append(element('p', 'empty', rows.length ? 'Inga hänvisningar matchar filtret.' : 'API:t hittade inga hänvisningar. Kontrollera textutvinningen. Detta bevisar inte att dokumentet saknar hänvisningar.'));
}

async function checkTarget(target, signal) {
  target.status = 'pending';
  target.sourceError = undefined;
  target.revision++;
  updateReport();
  const isLocal = Boolean($('#local-mode')?.checked);
  try {
    const resolution = isLocal
      ? await resolveTargetPrivate(target.uri, signal, { fallbackToResolve: false, sendDecoys: true })
      : await resolveTarget(target.uri, signal);
    signal.throwIfAborted();
    Object.assign(target, resolution);
  } catch (error) {
    if (signal.aborted) throw error;
    target.status = 'error';
    target.error = error.message;
  }
  target.revision++;
  updateReport();
  if (target.status !== 'found') return;
  try {
    const uri = (target.result?.uri ?? target.uri).split('#')[0];
    if (!sourceCache.has(uri)) sourceCache.set(uri, getDocumentSource(uri, signal, { privacyMode: isLocal }));
    const source = await sourceCache.get(uri);
    const markdown = source?.markdown ?? source?.text;
    if (typeof markdown !== 'string') throw new Error('API:t returnerar ingen källtext.');
    for (const row of rows.filter(row => row.occurrence.targets.some(item => item.uri === target.uri))) {
      signal.throwIfAborted();
      const evidence = await work('evidence', { markdown, anchors: source.anchors, uri: target.result.pin?.uri ?? target.uri, claim: row.claim });
      signal.throwIfAborted();
      row.evidence.set(target.uri, evidence);
    }
  } catch (error) {
    if (signal.aborted) throw error;
    target.sourceError = error.message;
    sourceCache.delete((target.result?.uri ?? target.uri).split('#')[0]);
  }
  target.revision++;
  updateReport();
}

async function checkTargets(items, signal) {
  let done = 0;
  setProgress(items.length ? 0 : null, `Kontrollerar källor och hämtar text · 0 av ${items.length}`);
  await pool(items, async target => {
    await checkTarget(target, signal);
    setProgress(++done / items.length, `Kontrollerar källor och hämtar text · ${done} av ${items.length}`);
  }, signal);
}

// The server model runs in normal mode; the local browser model runs in
// integritetsläge. Both return the same result shape for the report.
async function assessClaim(claim, evidence, isLocal, signal) {
  if (isLocal) return semantics.assess(claim, evidence, signal);
  // The server windows the premise itself. Send the selected passages as one
  // source in document order, so the model reads coherent context instead of
  // BM25-ranked fragments in the wrong order.
  const ordered = [...evidence.passages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const citation = [...new Set(ordered.map(passage => [passage.court, passage.section].filter(Boolean).join(' ')).filter(Boolean))].join(' · ') || undefined;
  const sources = ordered.length ? [{ text: ordered.map(passage => passage.text).join('\n\n'), citation }] : [];
  const response = await matchClaimRemote(claim.hypothesis, sources, { signal });
  return {
    status: response.status,
    reason: response.reason,
    evidence: response.evidence ? { text: response.evidence.source ?? response.evidence } : undefined,
    comparisons: (response.comparisons ?? []).map(item => ({ text: item.source, scores: item.scores })),
    backend: 'Server',
    model: response.model_version || response.model,
  };
}

async function compareClaims(signal, retry = false) {
  const isLocal = Boolean($('#local-mode')?.checked);
  let failure;
  let done = 0;
  for (const row of rows) {
    for (const target of row.occurrence.targets.map(item => targets.get(item.uri))) {
      signal.throwIfAborted();
      if (retry && !row.semantic.get(target.uri)?.retryable) continue;
      if (target.status === 'invalid') {
        row.semantic.set(target.uri, { status: 'abstain', reason: 'Hänvisningen är ogiltig.' });
        row.semanticRevision++;
        updateReport();
        continue;
      }
      const evidence = row.evidence.get(target.uri);
      let reason = !row.claim.assessable ? row.claim.reason
        : target.status !== 'found' ? 'Källan har inte bekräftats.'
        : target.sourceError ? 'Källtexten kunde inte hämtas för jämförelse.'
        : !evidence?.passages?.length ? 'Inga relevanta källavsnitt hittades i källtexten.'
        : new URL(target.uri).hash && !evidence.exact && target.source === 'sfs' ? 'Den hänvisade bestämmelsen kunde inte avgränsas.'
        : evidence?.reason;
      let result;
      if (reason) result = { status: 'abstain', reason };
      else if (failure) result = { status: 'abstain', reason: failure, retryable: true };
      else {
        setProgress(done / rows.length, `${isLocal ? 'Jämför påståenden lokalt' : 'Jämför påståenden på servern'} · hänvisning ${done + 1} av ${rows.length}`);
        try {
          result = await assessClaim(row.claim, evidence, isLocal, signal);
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw error;
          failure = isLocal ? error.message : 'Serverjämförelsen kunde inte nås. Försök igen.';
          if (isLocal) semantics.stop();
          result = { status: 'abstain', reason: failure, retryable: true };
        }
      }
      row.semantic.set(target.uri, result);
      row.semanticRevision++;
      updateReport();
    }
    done++;
  }
}

function updatePrivacyNote() {
  const isLocal = Boolean($('#local-mode')?.checked);
  const note = $('#privacy-note');
  if (!note) return;
  if (isLocal) {
    note.innerHTML = '<span aria-hidden="true">🔒</span> <strong>Integritetsläge.</strong> Dokumentet och dina hänvisningar stannar på din enhet. Jämförelsen körs av en lokal modell i webbläsaren, som hämtar cirka 25 MB modellfiler första gången. <a href="./sa-funkar-det.html">Så funkar det</a>.';
  } else {
    note.innerHTML = '<span aria-hidden="true">↳</span> <strong>Normalläge.</strong> Texten skickas till lagen.nu för att hitta hänvisningar. Påståenden och utvalda källavsnitt jämförs på slopchecks server. Inget sparas. <a href="./sa-funkar-det.html">Så funkar det</a>.';
  }
}

if ($('#local-mode')) {
  // Integritetsläge defaults to off on every load.
  $('#local-mode').checked = false;
  updatePrivacyNote();
  $('#local-mode').addEventListener('change', () => {
    updatePrivacyNote();
    if ($('#local-mode').checked) prefetchCorePack();
  });
}

$('#check').addEventListener('click', async () => {
  resetReport();
  controller = new AbortController();
  const signal = controller.signal;
  busy(true);
  const isLocal = Boolean($('#local-mode')?.checked);
  warnings([]);
  try {
    if (selectedFile && !blocks.length) await readSelectedFile(signal);
    signal.throwIfAborted();
    progress(isLocal ? 'Hittar hänvisningar lokalt i webbläsaren…' : 'Hittar hänvisningar genom lagen.nu…');
    validateBlocks(blocks);
    checkedBlocks = blocks.map(block => ({ ...block }));
    const occurrences = mergeOccurrences(await extract(checkedBlocks, signal, { local: isLocal }), checkedBlocks);
    signal.throwIfAborted();
    rows = occurrences.map(occurrence => ({ occurrence, claim: semanticClaim(occurrence, claimContext(occurrence, checkedBlocks), checkedBlocks, occurrences), evidence: new Map(), semantic: new Map(occurrence.targets.map(target => [target.uri, { status: 'pending' }])), semanticRevision: 0 }));
    for (const row of rows) for (const target of row.occurrence.targets) targets.set(target.uri, { ...target, status: 'pending', revision: 0 });
    reportName = selectedFile ? selectedFile.name : 'Inklistrad text';
    reportDate = new Date().toLocaleString('sv');
    const modeLabel = isLocal ? 'Integritetsläge · lokal jämförelse i webbläsaren' : 'Normalläge · serverjämförelse';
    $('#report-meta').textContent = `${reportName} · ${reportDate} · ${targets.size} unika mål · ${modeLabel} (experimentellt)`;
    $('#filter').value = 'all';
    $('#results').replaceChildren(...rows.map(makeRow));
    showDocument();
    $('#report').hidden = false;
    $('#input-wrap').open = false;
    updateReport();
    $('#report-heading').tabIndex = -1;
    $('#report-heading').focus({ preventScroll: true });
    $('#report').scrollIntoView({ block: 'start' });
    await checkTargets([...targets.values()], signal);
    if (selectedRow === null && rows.length) selectRow(Math.max(0, rows.findIndex((_, index) => rowStatus(index) === 'invalid')));
    await compareClaims(signal);
  } catch (error) {
    if (error.name !== 'AbortError') displayError(error);
  } finally {
    busy(false);
  }
});

$('#retry').addEventListener('click', async () => {
  controller = new AbortController();
  const signal = controller.signal;
  busy(true);
  $('#error').hidden = true;
  try {
    await checkTargets([...targets.values()].filter(target => target.status === 'error' || target.sourceError), signal);
    await compareClaims(signal);
  } catch (error) {
    if (error.name !== 'AbortError') displayError(error);
  } finally {
    busy(false);
  }
});

$('#retry-semantic').addEventListener('click', async () => {
  controller = new AbortController();
  const signal = controller.signal;
  busy(true);
  try { await compareClaims(signal, true); }
  catch (error) { if (error.name !== 'AbortError') displayError(error); }
  finally { busy(false); }
});

$('#cancel').addEventListener('click', () => {
  controller?.abort();
  stopWorker();
  stopExtractionWorker();
  semantics.stop();
  for (const row of rows) for (const [uri, result] of row.semantic) {
    if (result.status === 'pending') {
      row.semantic.set(uri, { status: 'abstain', reason: 'Jämförelsen avbröts.', retryable: true });
      row.semanticRevision++;
    }
  }
  for (const target of targets.values()) {
    if (target.status === 'pending') {
      target.status = 'error';
      target.error = 'Kontrollen avbröts. Försök igen för att kontrollera målet.';
    } else if (target.status === 'found' && rows.some(row => row.occurrence.targets.some(t => t.uri === target.uri) && !row.evidence.has(target.uri))) {
      target.sourceError = 'Hämtningen avbröts.';
    }
    target.revision++;
  }
  sourceCache.clear();
  if (rows.length) updateReport();
  warnings(['Kontrollen avbröts. Texten och färdiga resultat finns kvar under denna session.']);
});

$('#filter').addEventListener('change', updateReport);
$('#clear').addEventListener('click', () => {
  controller?.abort();
  stopWorker();
  stopExtractionWorker();
  $('#text').value = '';
  $('#text').dispatchEvent(new Event('input'));
  $('#input-wrap').open = true;
  busy(false);
  $('#text').focus();
});

let printState;
window.addEventListener('beforeprint', () => {
  printState = [...$('#results').querySelectorAll('details')].map(node => [node, node.open]);
  for (const [node] of printState) node.open = true;
  for (const node of $('#results').querySelectorAll('[data-row]')) node.hidden = false;
  document.title = `slopcheck — ${reportName} — ${reportDate}`;
});
window.addEventListener('afterprint', () => {
  for (const [node, open] of printState ?? []) node.open = open;
  document.title = 'slopcheck — kontrollera juridiska hänvisningar';
  updateReport();
});
$('#print').addEventListener('click', () => window.print());

// Only immutable model assets enter Cache Storage. Documents and results stay in memory.
// Only citation text goes to POST /citations/extract; GET requests carry target URIs.
