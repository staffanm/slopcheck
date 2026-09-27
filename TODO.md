HÖGSTA DOMSTOLENS DOM meddelad i Stockholm den 8 maj 2026 Mål nr B 8157-25

"HÖGSTA DOMSTOLEN DOM B 8157-25"
Kunde inte bedömas · experimentellt
Påståendet är avbrutet vid en sid- eller styckegräns.

This is not even a claim -- why was it interpreted as one?

"Olovlig befattning med narkotika är straffbar enligt 1 § första stycket 1–5 narkotikastrafflagen (1968:64)."
Kunde inte bedömas · experimentellt
Den hänvisade bestämmelsen kunde inte avgränsas.

The start (https://lagen.nu/1968:64#P1S1N1) and end (https://lagen.nu/1968:64#P1S1N5) of the reference is recognized - it should be possible to compare to just that span

"Med hänsyn till de skadeverkningar narkotikaförsäljning medför ansågs höjningen av straffminimum inte heller som oproportionerlig i de fall brottet begås utan anknytning till kriminella nätverk. (Se prop. 2022/23:53 s. 100 f., 104 och 111.)"
Kunde inte bedömas · experimentellt
Inget avgränsat påstående kunde skiljas från hänvisningen.

The citation isn't properly recognized ("prop. 2022/23:53 s. 100" is recognized as https://lagen.nu/prop/2022/23:53#sid100, the trailing "f." (following page) should be understood as https://lagen.nu/prop/2022/23:53#sid101, "104 och 111" should be recognized as two specific pages. (should be fixed at lagen.nu, in the citations/extract endpoint)

The claim is also not recognized since its in the preceeding sentence, not the same sentence as the citation. For this particular citation pattern (the parenthis contains a full sentence, folliwing a completed sentence) we should probably support it.

"Undantag är tänkbara men vanligen endast när det finns ett nära tidsmässigt eller rumsligt samband mellan de olika moment som annars skulle utgöra egna brottsenheter. (Jfr ”De upprepade förfalskningarna” NJA 2018 s. 378 p. 12.)"
De upprepade förfalskningarna (NJA 2018 s. 378) ↗
Kunde inte bedömas · experimentellt
Inget avgränsat påstående kunde skiljas från hänvisningen.

Apart from the failure to extract a claim, the citation is specifically to p. 12 of the verdict (requires fix at lagen.nu in the citations/extract endpoint). Any semantic check of the claim should only look at that paragraph.

"jfr ”Upprepade försäljningar av narkotika I” NJA 1971 s. 396 "
lagen.nu kan inte bekräfta källan.

We don't keep NJA cases before 1981. We can tell that this is a valid citation though because it has been named in https://www.domstol.se/globalassets/filer/domstol/hogstadomstolen/namngivna-rattsfall/officiell-lista-over-namngivna-rattsfall.pdf which we ingest for the dv source. Maybe lagen.nu should create placeholder/ghost entries for the 130 such cases?
## Improving the server model (26 September 2026)

On the corrected legal-claims fixture, Gemma 4 31B with a prompt reaches 0.96 precision while
KB-BERT v5 reaches 0.60 (top label). Both read one claim against one source, so the gap is not
the task. Ideas, in the order I expect them to matter:

1. Train on real pairs labelled by a strong judge. v5 learns from rule-made pairs (rewrites,
   neighbour chunks, swapped sources) and is nearly as good as Gemma on those, but not on
   hand-written claims. Have Gemma 4 31B (run-gemma4.sh, about 11 s per pair on the 3090) label
   authentic corpus claims with their cited sources, and claims from real documents run through
   the extractor; distil the server model from those labels. The same labels then improve the
   browser student.
2. Give the model the context the claim needs. v5 reads one BM25 window of 380 tokens; Gemma read
   the whole cited unit. Several fixture failures need text outside the window (an exception in
   a later paragraph, HD's conclusion pages away from the matching words). Rank passages with a
   cross-encoder instead of BM25, and add the section's exceptions to the window.
3. A larger encoder. The server is not bound by the 25 MB browser limit. Candidates from KBLab:
   - KBLab/megatron-bert-large-swedish-cased-165-zero-shot: 370 M parameters (3 times KB-BERT),
     already fine-tuned on Swedish QNLI and MNLI, so it starts as an NLI model;
   - KBLab/megatron-bert-large-swedish-cased-165k: the same model before NLI fine-tuning;
   - KBLab/electra-base-swedish-cased-discriminator: base size, an alternative to KB-BERT.
   Measure CPU latency on ludo (3 threads) before choosing; a large model is roughly 3 times
   slower per claim than v5.
