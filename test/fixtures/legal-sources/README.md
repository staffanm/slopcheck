# Frozen legal source text

Rendered on 16 September 2026 from the lagen.nu corpus with the same
`document_markdown` renderer that serves `GET /api/v1/document?format=md`.
Judgment reports are complete. Statute files hold the cited provision, its
neighbours where the claims need them, and the chapter heading the provision
selector keys on.

| File | Content |
|---|---|
| `avtalslagen-4.md`, `avtalslagen-36.md` | 4 § and 36 § [avtalslagen](https://lagen.nu/1915:218) |
| `skadestandslagen-2kap.md` | 2 kap. 1–2 §§ [skadeståndslagen](https://lagen.nu/1972:207#K2) |
| `preskriptionslagen-2.md` | 2 § [preskriptionslagen](https://lagen.nu/1981:130#P2) |
| `rantelagen-6.md` | 6 § [räntelagen](https://lagen.nu/1975:635#P6) |
| `rattegangsbalken-18kap.md`, `rattegangsbalken-50kap.md` | 18 kap. 1 § and 50 kap. 1–2 §§ [rättegångsbalken](https://lagen.nu/1942:740) |
| `brottsbalken-3kap.md` | 3 kap. 1–2 §§ [brottsbalken](https://lagen.nu/1962:700#K3) |
| `koplagen-32.md` | 32 § [köplagen](https://lagen.nu/1990:931#P32) |
| `tryckfrihetsforordningen-2kap.md` | 2 kap. 1 § [tryckfrihetsförordningen](https://lagen.nu/1949:105#K2), with the chapter's sub-headings |
| `nja2004s176.md` | [NJA 2004 s. 176](https://lagen.nu/dom/nja/2004s176), HIV-fallet |
| `nja2005s805.md` | [NJA 2005 s. 805](https://lagen.nu/dom/nja/2005s805), Predikan i Borgholm |
| `nja2013s502.md` | [NJA 2013 s. 502](https://lagen.nu/dom/nja/2013s502), Juniavgörandet |
| `nja2020s1042.md` | [NJA 2020 s. 1042](https://lagen.nu/dom/nja/2020s1042), Badrumsfixarens rättegångskostnad |
| `hfd2013ref71.md` | [HFD 2013 ref. 71](https://lagen.nu/dom/hfd/2013:71) |

The statute fixtures preserve the exceptions and reservations the misleading
claims drop. The judgment fixtures preserve lower-court reasoning, the
reporting court's reasoning, its summary where one exists, and its decision.
`../legal-claims.jsonl` states 70 claims against these texts, in the pair format of
`data/*.jsonl`, each labelled supported, unsupported, misleading, incorrect or nonsensical.
These fixtures test software behavior. They are not an independent evaluation of legal accuracy.
