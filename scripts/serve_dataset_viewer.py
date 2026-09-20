#!/usr/bin/env python3
"""
Simple, responsive mobile web UI for inspecting the slopcheck dataset.
Serves on 0.0.0.0:8088 using Python standard library http.server.
Supports side-by-side and tabbed viewing of actual vs cleaned claims,
and displays pair IDs and numbers for easy communication.
"""

import argparse
import json
import os
import re
import urllib.parse
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

# Preload dataset into memory
ROWS: list[dict] = []
REVIEW_IDS: set[str] = set()
FAMILY_MAP: dict[str, list[dict]] = {}

def load_data():
    global ROWS, REVIEW_IDS, FAMILY_MAP
    ROWS = []
    FAMILY_MAP = {}
    
    # Load review sample IDs
    review_path = DATA_DIR / "sample_review.jsonl"
    if review_path.exists():
        with open(review_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    REVIEW_IDS.add(r["id"])

    # Load partitions
    for split in ["train", "validation", "calibration", "test"]:
        sp_path = DATA_DIR / f"{split}.jsonl"
        if sp_path.exists():
            with open(sp_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        r = json.loads(line)
                        r["split"] = split
                        r["in_sample_review"] = r["id"] in REVIEW_IDS
                        ROWS.append(r)
                        fam_id = r.get("origin_claim_id", r["id"])
                        FAMILY_MAP.setdefault(fam_id, []).append(r)

    # Fallback to all_generated_pairs if partitions don't exist
    if not ROWS:
        all_path = DATA_DIR / "all_generated_pairs.jsonl"
        if all_path.exists():
            with open(all_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        r = json.loads(line)
                        r["split"] = "unassigned"
                        ROWS.append(r)
                        fam_id = r.get("origin_claim_id", r["id"])
                        FAMILY_MAP.setdefault(fam_id, []).append(r)

    # Enrich rows with index, normalized sources, base_claim, and actual_text
    for idx, r in enumerate(ROWS):
        r["index"] = idx + 1
        
        # Normalize sources
        if "sources" not in r and "source" in r:
            r["sources"] = [r["source"]]
        elif "sources" not in r:
            r["sources"] = []
        r["source_count"] = len(r["sources"])

        fam_id = r.get("origin_claim_id", r["id"])
        fam = FAMILY_MAP.get(fam_id, [])
        auth_row = next((x for x in fam if x.get("origin") == "authentic"), None)
        
        target_row = auth_row if auth_row else r
        target_sources = target_row.get("sources") or ([target_row["source"]] if "source" in target_row else [])
        cit_parts = [s.get("citation") or s.get("source_id", "") for s in target_sources if s.get("citation") or s.get("source_id")]
        cit_str = ", ".join(cit_parts)

        r["base_claim"] = target_row.get("claim")
        if target_row.get("actual_text"):
            r["actual_text"] = target_row.get("actual_text")
        else:
            r["actual_text"] = f"{target_row.get('claim')} (Se {cit_str})." if cit_str else target_row.get('claim')

    print(f"Loaded {len(ROWS)} total rows across {len(FAMILY_MAP)} families.")


HTML_PAGE = """<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Slopcheck Dataset Viewer</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --supported: #10b981;
      --supported-bg: rgba(16, 185, 129, 0.15);
      --unsupported: #64748b;
      --unsupported-bg: rgba(100, 116, 139, 0.2);
      --incorrect: #f43f5e;
      --incorrect-bg: rgba(244, 63, 94, 0.15);
      --misleading: #f59e0b;
      --misleading-bg: rgba(245, 158, 11, 0.15);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding-bottom: 80px;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      padding: 12px 16px;
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    h1 { font-size: 1.15rem; font-weight: 700; color: #fff; }
    .badge-count {
      font-size: 0.8rem;
      background: #334155;
      padding: 2px 8px;
      border-radius: 999px;
      color: var(--accent);
      font-weight: 600;
    }
    .search-box {
      width: 100%;
      padding: 10px 14px;
      background: #090e17;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
      margin-bottom: 8px;
    }
    .search-box:focus { border-color: var(--accent); }
    
    .global-view-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .btn-toggle-view {
      background: #1e293b;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-toggle-view.active {
      background: #0284c7;
      color: #fff;
      border-color: #38bdf8;
    }

    .filter-scroll {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 4px;
      scrollbar-width: none;
    }
    .filter-scroll::-webkit-scrollbar { display: none; }
    .chip {
      white-space: nowrap;
      padding: 5px 10px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
    }
    .chip.active {
      background: var(--accent);
      color: #0f172a;
      border-color: var(--accent);
      font-weight: 700;
    }
    .container {
      padding: 12px 16px;
      max-width: 860px;
      margin: 0 auto;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2);
    }
    
    /* Prominent Card ID header */
    .card-top-id-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .id-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .row-index-badge {
      background: var(--accent);
      color: #0f172a;
      font-weight: 800;
      font-size: 0.82rem;
      padding: 2px 7px;
      border-radius: 6px;
    }
    .row-id-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8rem;
      background: #090e17;
      color: #38bdf8;
      padding: 2px 8px;
      border-radius: 6px;
      border: 1px solid #334155;
    }
    .btn-copy {
      background: #334155;
      border: none;
      color: #cbd5e1;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-copy:hover { background: #475569; }

    .card-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .tag {
      font-size: 0.72rem;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .tag-supported { background: var(--supported-bg); color: var(--supported); border: 1px solid rgba(16,185,129,0.3); }
    .tag-unsupported { background: var(--unsupported-bg); color: var(--unsupported); border: 1px solid rgba(100,116,139,0.3); }
    .tag-incorrect { background: var(--incorrect-bg); color: var(--incorrect); border: 1px solid rgba(244,63,94,0.3); }
    .tag-misleading { background: var(--misleading-bg); color: var(--misleading); border: 1px solid rgba(245,158,11,0.3); }
    .tag-split { background: #0f172a; color: #94a3b8; border: 1px solid #334155; }
    .tag-trans { background: #2a374a; color: #38bdf8; border: 1px solid #0284c7; }
    .tag-review { background: #581c87; color: #d8b4fe; border: 1px solid #9333ea; }
    .tag-source-count { background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); }
    
    /* Tab controls for Claim */
    .claim-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      flex-wrap: wrap;
      gap: 6px;
    }
    .section-title {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .claim-tabs {
      display: flex;
      gap: 4px;
      background: #090e17;
      padding: 2px;
      border-radius: 6px;
      border: 1px solid #334155;
    }
    .claim-tab-btn {
      background: none;
      border: none;
      color: #94a3b8;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.73rem;
      font-weight: 600;
      cursor: pointer;
    }
    .claim-tab-btn.active {
      background: #334155;
      color: #38bdf8;
    }

    /* Claim Display Boxes */
    .claim-box {
      font-size: 0.96rem;
      font-weight: 500;
      color: #ffffff;
      background: #0b1120;
      border-left: 3px solid var(--accent);
      padding: 10px 12px;
      border-radius: 4px;
      margin-bottom: 12px;
      line-height: 1.45;
    }
    .claim-box-actual {
      border-left-color: #a855f7;
      background: #140e26;
      color: #f1f5f9;
    }
    .box-sublabel {
      display: block;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--accent);
      margin-bottom: 4px;
    }
    .box-sublabel-actual {
      color: #c084fc;
    }

    /* Comparison side-by-side grid */
    .side-by-side-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }
    @media (max-width: 640px) {
      .side-by-side-grid {
        grid-template-columns: 1fr;
      }
    }

    .source-box {
      background: #131d2e;
      border: 1px solid #23354d;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 0.88rem;
      margin-bottom: 12px;
    }
    .citation-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      flex-wrap: wrap;
      gap: 6px;
    }
    .citation-title {
      font-weight: 600;
      color: #38bdf8;
      font-size: 0.86rem;
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }
    .unit-type-pill {
      font-size: 0.68rem;
      font-weight: 600;
      color: #94a3b8;
      background: #090e17;
      border: 1px solid #1e293b;
      padding: 1px 6px;
      border-radius: 4px;
    }
    .source-links {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
    }
    .link-lagen {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 0.72rem;
      font-weight: 600;
      color: #38bdf8;
      background: #0f172a;
      border: 1px solid #334155;
      padding: 2px 7px;
      border-radius: 4px;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .link-lagen:hover {
      background: #1e293b;
      border-color: #38bdf8;
      color: #7dd3fc;
    }
    .link-lagen-doc {
      color: #a5b4fc;
      border-color: #312e81;
    }
    .link-lagen-doc:hover {
      border-color: #818cf8;
      color: #c7d2fe;
    }
    .link-lagen-origin {
      color: #cbd5e1;
      text-decoration: none;
      font-size: 0.76rem;
      border-bottom: 1px dashed #64748b;
      padding-bottom: 1px;
    }
    .link-lagen-origin:hover {
      color: #38bdf8;
      border-bottom-color: #38bdf8;
    }
    .source-snippet {
      color: #cbd5e1;
      line-height: 1.45;
      font-size: 0.85rem;
    }
    .source-full {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed #334155;
      color: #94a3b8;
      white-space: pre-wrap;
      font-size: 0.82rem;
      max-height: 350px;
      overflow-y: auto;
    }
    .btn-toggle-source {
      background: none;
      border: none;
      color: #38bdf8;
      font-size: 0.8rem;
      cursor: pointer;
      font-weight: 600;
      margin-top: 6px;
      padding: 4px 0;
      display: inline-block;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 8px;
    }
    .btn-family {
      background: #334155;
      border: none;
      color: #f8fafc;
      font-size: 0.78rem;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
    }
    .btn-family:hover { background: #475569; }

    /* Pagination */
    .pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
    }
    .btn-page {
      background: #1e293b;
      border: 1px solid #334155;
      color: #f8fafc;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-page:disabled { opacity: 0.35; cursor: not-allowed; }
    .page-info { font-size: 0.85rem; color: var(--text-muted); font-weight: 500; }

    /* Modal for family view */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85);
      z-index: 200;
      padding: 16px;
      overflow-y: auto;
    }
    .modal-content {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      max-width: 820px;
      margin: 20px auto;
      padding: 16px;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
    }
    .btn-close {
      background: #334155;
      border: none;
      color: #fff;
      font-size: 1.1rem;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
    }
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #38bdf8;
      color: #0f172a;
      font-weight: 700;
      font-size: 0.85rem;
      padding: 8px 16px;
      border-radius: 8px;
      z-index: 300;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      display: none;
    }
  </style>
</head>
<body>

<header>
  <div class="header-top">
    <h1>Slopcheck Dataset</h1>
    <span class="badge-count" id="totalCountBadge">Laddar...</span>
  </div>
  <input type="search" id="searchInput" class="search-box" placeholder="Sök #id, påstående, källa eller lagrum...">
  
  <div class="global-view-bar">
    <span>Vy:</span>
    <button class="btn-toggle-view active" data-view="cleaned" onclick="setGlobalView('cleaned')">Rensat</button>
    <button class="btn-toggle-view" data-view="actual" onclick="setGlobalView('actual')">Faktisk text</button>
    <button class="btn-toggle-view" data-view="both" onclick="setGlobalView('both')">Sida vid sida</button>
  </div>

  <div class="filter-scroll" id="splitFilter">
    <button class="chip active" data-filter="all">Alla split</button>
    <button class="chip" data-filter="sample_review">⭐ Granskningsurval (50)</button>
    <button class="chip" data-filter="train">Train</button>
    <button class="chip" data-filter="validation">Validation</button>
    <button class="chip" data-filter="calibration">Calibration</button>
    <button class="chip" data-filter="test">Test</button>
  </div>

  <div class="filter-scroll" id="labelFilter" style="margin-top: 6px;">
    <button class="chip active" data-label="all">Alla etiketter</button>
    <button class="chip" data-label="supported">Supported</button>
    <button class="chip" data-label="unsupported">Unsupported</button>
    <button class="chip" data-label="incorrect">Incorrect</button>
    <button class="chip" data-label="misleading">Misleading</button>
  </div>

  <div class="filter-scroll" id="sourceCountFilter" style="margin-top: 6px;">
    <button class="chip active" data-count="all">Alla källantal</button>
    <button class="chip" data-count="1">1 källa</button>
    <button class="chip" data-count="multi">Flera källor (2+)</button>
    <button class="chip" data-count="2">2 källor</button>
    <button class="chip" data-count="3+">3+ källor</button>
  </div>
</header>

<div class="container">
  <div id="cardsList"></div>
  <div class="pagination">
    <button class="btn-page" id="btnPrev" disabled>← Föregående</button>
    <span class="page-info" id="pageInfo">Sida 1</span>
    <button class="btn-page" id="btnNext">Nästa →</button>
  </div>
</div>

<div class="modal-overlay" id="familyModal">
  <div class="modal-content">
    <div class="modal-header">
      <h2 style="font-size: 1.1rem;">Claim Family (Alla varianter)</h2>
      <button class="btn-close" onclick="closeFamilyModal()">✕ Stäng</button>
    </div>
    <div id="familyCardsList"></div>
  </div>
</div>

<div class="toast" id="toast">ID kopierat!</div>

<script>
let currentPage = 1;
const pageSize = 20;
let currentSplit = 'all';
let currentLabel = 'all';
let currentSourceCount = 'all';
let currentSearch = '';
let currentGlobalView = 'cleaned'; // 'cleaned', 'actual', 'both'
const cardViewModes = {}; // id -> 'cleaned' | 'actual' | 'both'

const searchInput = document.getElementById('searchInput');
const splitFilter = document.getElementById('splitFilter');
const labelFilter = document.getElementById('labelFilter');
const sourceCountFilter = document.getElementById('sourceCountFilter');
const cardsList = document.getElementById('cardsList');
const pageInfo = document.getElementById('pageInfo');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const totalCountBadge = document.getElementById('totalCountBadge');
const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2000);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Kopierade: ' + text);
  }).catch(() => {
    showToast('Kunde inte kopiera');
  });
}

function setGlobalView(mode) {
  currentGlobalView = mode;
  document.querySelectorAll('.btn-toggle-view').forEach(b => {
    b.classList.toggle('active', b.dataset.view === mode);
  });
  // Update all rendered cards
  document.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    if (id) {
      setCardView(id, mode);
    }
  });
}

function setCardView(id, mode) {
  cardViewModes[id] = mode;
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;

  // Update card tab buttons
  card.querySelectorAll('.claim-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === mode);
  });

  const cleanedEl = card.querySelector('.claim-view-cleaned');
  const actualEl = card.querySelector('.claim-view-actual');
  const bothEl = card.querySelector('.claim-view-both');

  if (cleanedEl) cleanedEl.style.display = (mode === 'cleaned') ? 'block' : 'none';
  if (actualEl) actualEl.style.display = (mode === 'actual') ? 'block' : 'none';
  if (bothEl) bothEl.style.display = (mode === 'both') ? 'grid' : 'none';
}

// Event Listeners
splitFilter.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    splitFilter.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentSplit = chip.dataset.filter;
    currentPage = 1;
    loadRows();
  });
});

labelFilter.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    labelFilter.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentLabel = chip.dataset.label;
    currentPage = 1;
    loadRows();
  });
});

sourceCountFilter.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    sourceCountFilter.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentSourceCount = chip.dataset.count;
    currentPage = 1;
    loadRows();
  });
});

let searchTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentSearch = e.target.value.trim();
    currentPage = 1;
    loadRows();
  }, 300);
});

btnPrev.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    loadRows();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

btnNext.addEventListener('click', () => {
  currentPage++;
  loadRows();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function loadRows() {
  cardsList.innerHTML = '<div style="text-align:center; padding: 40px; color: #94a3b8;">Laddar par...</div>';
  const params = new URLSearchParams({
    page: currentPage,
    page_size: pageSize,
    split: currentSplit,
    label: currentLabel,
    sources: currentSourceCount,
    q: currentSearch
  });
  
  try {
    const res = await fetch('/api/rows?' + params.toString());
    const data = await res.json();
    renderCards(data.rows);
    
    totalCountBadge.textContent = `${data.total} rader`;
    const totalPages = Math.ceil(data.total / pageSize) || 1;
    pageInfo.textContent = `Sida ${currentPage} av ${totalPages} (${data.total} st)`;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= totalPages;
  } catch (err) {
    cardsList.innerHTML = `<div style="color: #f43f5e; padding: 20px;">Fel vid laddning: ${err.message}</div>`;
  }
}

function renderCards(rows, container = cardsList, isFamilyModal = false) {
  if (!rows || rows.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding: 40px; color: #64748b;">Inga träffar hittades.</div>';
    return;
  }

  container.innerHTML = rows.map(r => {
    const mode = cardViewModes[r.id] || currentGlobalView;
    const labelClass = `tag-${r.label}`;
    const transText = r.transformation ? r.transformation : (r.origin === 'authentic' ? 'authentic' : '');
    const sources = r.sources || (r.source ? [r.source] : []);
    const srcCount = sources.length;

    const actualText = r.actual_text || r.claim;
    const isTransformed = (r.origin === 'counterfactual' || r.transformation);
    const actualSublabel = isTransformed ? '🏛️ Faktisk domtext / Baspåstående' : '🏛️ Faktisk domtext (med källhänvisning)';
    const cleanSublabel = isTransformed ? `💡 Rensat påstående (${r.transformation})` : '💡 Rensat påstående (Modellindata)';

    const sourceBlocksHtml = sources.map((s, s_idx) => {
      const srcText = s.text || '';
      const srcSnippet = srcText.length > 220 ? srcText.slice(0, 220) + '...' : srcText;
      const hasMore = srcText.length > 220;
      const sId = `${r.id}_s${s_idx}`;
      const headerLabel = srcCount > 1 ? `[Källa ${s_idx + 1}: ${s.citation || s.source_id || 'källa'}]` : `📖 ${s.citation || s.source_id || 'källa'}`;
      const linksHtml = renderSourceLinks(s);
      return `
        <div class="source-box">
          <div class="citation-header">
            <div class="citation-title">
              ${escapeHtml(headerLabel)}
              <span class="unit-type-pill">${escapeHtml(s.unit_type || 'källa')}</span>
            </div>
            ${linksHtml ? `<div class="source-links">${linksHtml}</div>` : ''}
          </div>
          <div class="source-snippet">${escapeHtml(srcSnippet)}</div>
          ${hasMore ? `
            <div class="source-full" id="full_${sId}">${escapeHtml(srcText)}</div>
            <button class="btn-toggle-source" onclick="toggleSource('${sId}')">Visa hela källan (${srcText.length} tecken) ▼</button>
          ` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="card" data-id="${r.id}">
        <!-- Top ID & Communication Bar -->
        <div class="card-top-id-row">
          <div class="id-group">
            <span class="row-index-badge">#${r.index}</span>
            <code class="row-id-code">${escapeHtml(r.id)}</code>
            <button class="btn-copy" onclick="copyToClipboard('${r.id}')" title="Kopiera ID">📋 Kopiera ID</button>
          </div>
          <span style="font-size: 0.75rem; color: #94a3b8;">${r.token_length || 0} tokens</span>
        </div>

        <!-- Labels & Tags -->
        <div class="card-header">
          <div class="tags">
            <span class="tag ${labelClass}">${r.label}</span>
            <span class="tag tag-source-count">📚 ${srcCount} ${srcCount === 1 ? 'källa' : 'källor'}</span>
            ${transText ? `<span class="tag tag-trans">${transText}</span>` : ''}
            <span class="tag tag-split">${r.split}</span>
            ${r.in_sample_review ? '<span class="tag tag-review">⭐ Granskningsurval</span>' : ''}
          </div>
        </div>

        <!-- Claim Header & Tabs -->
        <div class="claim-header-row">
          <div class="section-title">Påstående (Claim)</div>
          <div class="claim-tabs">
            <button class="claim-tab-btn ${mode === 'cleaned' ? 'active' : ''}" data-tab="cleaned" onclick="setCardView('${r.id}', 'cleaned')">Rensat</button>
            <button class="claim-tab-btn ${mode === 'actual' ? 'active' : ''}" data-tab="actual" onclick="setCardView('${r.id}', 'actual')">Faktisk</button>
            <button class="claim-tab-btn ${mode === 'both' ? 'active' : ''}" data-tab="both" onclick="setCardView('${r.id}', 'both')">Jämför</button>
          </div>
        </div>

        <!-- View 1: Cleaned -->
        <div class="claim-view-cleaned" style="display: ${mode === 'cleaned' ? 'block' : 'none'};">
          <div class="claim-box">
            <span class="box-sublabel">${cleanSublabel}</span>
            ${escapeHtml(r.claim)}
          </div>
        </div>

        <!-- View 2: Actual -->
        <div class="claim-view-actual" style="display: ${mode === 'actual' ? 'block' : 'none'};">
          <div class="claim-box claim-box-actual">
            <span class="box-sublabel box-sublabel-actual">${actualSublabel}</span>
            ${escapeHtml(actualText)}
          </div>
        </div>

        <!-- View 3: Side by Side (Both) -->
        <div class="side-by-side-grid claim-view-both" style="display: ${mode === 'both' ? 'grid' : 'none'};">
          <div class="claim-box claim-box-actual" style="margin-bottom:0;">
            <span class="box-sublabel box-sublabel-actual">${actualSublabel}</span>
            ${escapeHtml(actualText)}
          </div>
          <div class="claim-box" style="margin-bottom:0;">
            <span class="box-sublabel">${cleanSublabel}</span>
            ${escapeHtml(r.claim)}
          </div>
        </div>

        <!-- Sources / Evidence Premise -->
        <div class="section-title">Källor (Evidence Premise - ${srcCount} st)</div>
        ${sourceBlocksHtml}

        <!-- Meta row -->
        <div class="meta-row">
          <span>Ursprung: 
            ${r.origin_document_id ? `
              <a href="${escapeHtml(getLagenNuUrl(r.origin_document_id + (r.origin_paragraph ? '#' + r.origin_paragraph : '')))}" target="_blank" rel="noopener" class="link-lagen-origin" title="Öppna ursprungsdom på lagen.nu">
                <code>${escapeHtml(r.origin_document_id)}${r.origin_paragraph ? '#' + escapeHtml(r.origin_paragraph) : ''} ↗</code>
              </a>
            ` : '<code>Okänd</code>'}
          </span>
          ${!isFamilyModal ? `<button class="btn-family" onclick="showFamily('${r.origin_claim_id}')">Visa familj (${(r.origin_claim_id || '').split('#')[0].split('/').pop()})</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function toggleSource(id) {
  const el = document.getElementById('full_' + id);
  const btn = event.target;
  if (el.style.display === 'block') {
    el.style.display = 'none';
    btn.innerHTML = btn.innerHTML.replace('Dölj', 'Visa').replace('▲', '▼');
  } else {
    el.style.display = 'block';
    btn.innerHTML = btn.innerHTML.replace('Visa', 'Dölj').replace('▼', '▲');
  }
}

async function showFamily(familyId) {
  const modal = document.getElementById('familyModal');
  const list = document.getElementById('familyCardsList');
  modal.style.display = 'block';
  list.innerHTML = '<div style="color: #94a3b8; padding: 20px; text-align: center;">Hämtar familjemedlemmar...</div>';
  
  try {
    const res = await fetch('/api/family?id=' + encodeURIComponent(familyId));
    const data = await res.json();
    renderCards(data.rows, list, true);
  } catch (err) {
    list.innerHTML = `<div style="color:#f43f5e;">Fel: ${err.message}</div>`;
  }
}

function closeFamilyModal() {
  document.getElementById('familyModal').style.display = 'none';
}

function getLagenNuUrl(id) {
  if (!id) return '';
  if (id.startsWith('http://') || id.startsWith('https://')) return id;
  const clean = id.replace(/^\/+/, '');
  return 'https://lagen.nu/' + clean;
}

function renderSourceLinks(s) {
  const links = [];
  const srcId = (s.source_id || '').trim();
  const docId = (s.document_id || '').trim();

  const srcUrl = srcId ? getLagenNuUrl(srcId) : '';
  const docUrl = docId ? getLagenNuUrl(docId) : '';

  if (srcId) {
    const isPinpoint = srcId.includes('#');
    const label = isPinpoint ? `🎯 ${srcId}` : `📄 ${srcId}`;
    const title = isPinpoint ? 'Öppna pinpointad källa på lagen.nu' : 'Öppna källa på lagen.nu';
    links.push(`<a href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener" class="link-lagen" title="${title}">${escapeHtml(label)} ↗</a>`);
  }

  if (docId && docUrl && (!srcId || docUrl !== srcUrl)) {
    links.push(`<a href="${escapeHtml(docUrl)}" target="_blank" rel="noopener" class="link-lagen link-lagen-doc" title="Öppna hela grunddokumentet på lagen.nu">📄 ${escapeHtml(docId)} ↗</a>`);
  }

  return links.join('');
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

loadRows();
</script>

</body>
</html>
"""


class DatasetViewerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress logging every static request
        return

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/" or path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode("utf-8"))
            return

        elif path == "/api/stats":
            splits = {}
            labels = {}
            source_counts = {"1": 0, "2": 0, "3+": 0, "multi": 0}
            for r in ROWS:
                splits[r["split"]] = splits.get(r["split"], 0) + 1
                labels[r["label"]] = labels.get(r["label"], 0) + 1
                sc = len(r.get("sources", []))
                if sc == 1:
                    source_counts["1"] += 1
                elif sc == 2:
                    source_counts["2"] += 1
                    source_counts["multi"] += 1
                elif sc >= 3:
                    source_counts["3+"] += 1
                    source_counts["multi"] += 1
            data = {
                "total": len(ROWS),
                "splits": splits,
                "labels": labels,
                "source_counts": source_counts,
                "sample_review_count": len(REVIEW_IDS),
                "families_count": len(FAMILY_MAP)
            }
            self._send_json(data)
            return

        elif path == "/api/rows":
            split_filter = query.get("split", ["all"])[0]
            label_filter = query.get("label", ["all"])[0]
            source_filter = query.get("sources", ["all"])[0]
            search_query = query.get("q", [""])[0].lower().strip()
            page = int(query.get("page", [1])[0])
            page_size = int(query.get("page_size", [20])[0])

            filtered = ROWS

            if split_filter == "sample_review":
                filtered = [r for r in filtered if r.get("in_sample_review")]
            elif split_filter != "all":
                filtered = [r for r in filtered if r.get("split") == split_filter]

            if label_filter != "all":
                filtered = [r for r in filtered if r.get("label") == label_filter]

            if source_filter == "1":
                filtered = [r for r in filtered if len(r.get("sources", [])) == 1]
            elif source_filter == "2":
                filtered = [r for r in filtered if len(r.get("sources", [])) == 2]
            elif source_filter == "3+":
                filtered = [r for r in filtered if len(r.get("sources", [])) >= 3]
            elif source_filter == "multi":
                filtered = [r for r in filtered if len(r.get("sources", [])) >= 2]

            if search_query:
                # Check if search is a row number e.g. "#42" or "42"
                num_match = re.match(r"^#?(\d+)$", search_query)
                if num_match:
                    target_idx = int(num_match.group(1))
                    filtered = [r for r in filtered if r.get("index") == target_idx or search_query in r.get("id", "").lower()]
                else:
                    filtered = [
                        r for r in filtered
                        if search_query in r.get("id", "").lower()
                        or search_query in r.get("claim", "").lower()
                        or search_query in r.get("actual_text", "").lower()
                        or search_query in r.get("origin_document_id", "").lower()
                        or any(
                            search_query in s.get("citation", "").lower()
                            or search_query in s.get("source_id", "").lower()
                            or search_query in s.get("text", "").lower()
                            for s in r.get("sources", [])
                        )
                    ]

            total_filtered = len(filtered)
            start = (page - 1) * page_size
            end = start + page_size
            page_rows = filtered[start:end]

            self._send_json({
                "total": total_filtered,
                "page": page,
                "page_size": page_size,
                "rows": page_rows
            })
            return

        elif path == "/api/family":
            family_id = query.get("id", [""])[0]
            family_rows = FAMILY_MAP.get(family_id, [])
            self._send_json({
                "family_id": family_id,
                "rows": family_rows
            })
            return

        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

    def _send_json(self, data: Any):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))


def run_server(host: str = "0.0.0.0", port: int = 8088):
    load_data()
    server_address = (host, port)
    httpd = ThreadingHTTPServer(server_address, DatasetViewerHandler)
    print(f"\n=======================================================")
    print(f" Dataset Viewer Mobile Web UI is RUNNING")
    print(f" Local URL:     http://localhost:{port}")
    print(f" Network URL:   http://0.0.0.0:{port}")
    print(f"=======================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Serve mobile-friendly web UI for Slopcheck dataset.")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host interface to bind (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8088, help="Port to serve on (default 8088)")
    args = parser.parse_args()
    run_server(host=args.host, port=args.port)
