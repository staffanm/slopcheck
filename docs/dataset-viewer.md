# Dataset Viewer & Review UI

The dataset viewer (`scripts/serve_dataset_viewer.py`) is a lightweight, mobile-friendly web interface designed to inspect, search, and validate Swedish legal citation-claim pairs generated for the Slopcheck server-side classifier.

---

## 1. Quick Start

Run the viewer locally or expose it to your local network (e.g. for inspection from a mobile device):

```bash
python3 scripts/serve_dataset_viewer.py --host 0.0.0.0 --port 8088
```

Open `http://localhost:8088` (or `http://<machine-ip>:8088` on your phone).

---

## 2. Core Features

### 📖 Claim Inspection Modes
Each card allows switching between three viewing modes:
- **Rensat (Cleaned):** Displays the exact claim text provided as model hypothesis input (with parenthetical citations removed).
- **Faktisk (Actual):** Displays the verbatim original text from the court decision, including the citation parenthetical.
- **Jämför (Side-by-side):** Displays both the actual court text and the cleaned claim side by side for direct comparison.

### 📚 Multi-Source Evidence Premise
Under PRD Section 7, claims are evaluated against **all cited units in one input premise**. The UI displays:
- A badge showing the exact number of sources (e.g., `📚 2 källor`).
- Individual boxes for each cited unit (`[Källa 1: ...]`, `[Källa 2: ...]`).
- Collapsible source text: snippets are shown initially with a button to expand the full source passage.

### 🔗 Direct Navigation to lagen.nu
Every source and origin case is linked directly to its authoritative counterpart on [lagen.nu](https://lagen.nu):
- **`🎯 <source_id> ↗` (Pinpoint):** Opens the exact section, paragraph, or page anchor (e.g. `https://lagen.nu/1982:80#P29` or `https://lagen.nu/prop/2015/16:151#sid34`).
- **`📄 <document_id> ↗` (Parent Document):** Opens the overarching statute, proposition, or case judgment when a pinpoint is part of a larger enactment.
- **`Ursprung: ... ↗`:** Located in the card footer, opens the original deciding court decision (e.g. `dom/hd/B7821-24/2026-03-17#11`).

### 👨‍👩‍👧 Family View Modal
Each authentic pair forms an **authority family** sharing one `origin_claim_id`:
- `authentic` & `paraphrase` (`supported`)
- `distractor_source` & `reordered_sources` (`supported`)
- `adjacent` & `topic_match` (`unsupported`)
- `contradiction` (`incorrect`)
- `overstatement` (`misleading`)

Clicking **"Visa familj"** opens an interactive modal showing all family members together.

### 🔍 Search & Stratified Filtering
- **Quick Row & Text Search:** Type `#11` or `11` to jump directly to that row index, or search for keywords (e.g., `"Brevinkastet"`, `"anställningsskydd"`, or docket numbers like `"B7821-24"`).
- **Split Chips:** Filter by partition (`Alla`, `train`, `validation`, `calibration`, `test`).
- **⭐ Granskningsurval (50):** Directly loads the 50 stratified review samples representing all label and transformation combinations.
- **Label Chips:** Filter by `supported`, `unsupported`, `incorrect`, or `misleading`.
- **Source Count Chips:** Filter by `1 källa`, `Flera källor (2+)`, `2 källor`, or `3+ källor`.

---

## 3. Architecture & API Endpoints

The viewer is implemented as a zero-dependency Python HTTP server (`ThreadingHTTPServer`) serving a responsive single-page application with dark mode styling:

- `GET /`: Serves the HTML, CSS, and client-side JavaScript.
- `GET /api/stats`: Returns dataset-level breakdown across partitions, labels, source counts, and review sample sizes.
- `GET /api/rows?page=1&limit=20&split=...&label=...&sources=...&q=...`: Returns paginated and filtered row records.
- `GET /api/family?id=<origin_claim_id>`: Returns all rows belonging to the given family.
