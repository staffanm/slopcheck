# Claim extraction from a Swedish law thesis

The input file is the body of a Swedish LL.M. thesis (examensarbete i juridik).
Each line is one sentence with an id: `[page.sentence] text`. Footnotes were
moved inline: a footnote appears as a parenthesis right after the word or
sentence that carried the footnote marker, for example
`… kan inte konsumeras. (Mål C-128/11, p. 52.)` or `… enligt 7 kap. 1 § (Prop. 2012/13:1 s. 45.) och …`.

We are building a dataset of claim/source pairs: a claim from the thesis, and
the legal source that the thesis cites for it. Your job is to find, for each
footnote, the claim it supports, and decide whether the pair is usable.

## What to report

Report every parenthesis that is a footnote or a source reference: it names a
source (statute, case, preparatory work, EU act, treaty, author, report,
website), or it starts with "Se", "Jfr", "Ibid", "A.a.". Skip parentheses that
are the author's own asides and name no source, such as "(nedan IVF)" or
"(se avsnitt 3.2)".

For each one, write one JSON object on its own line to the output file:

```json
{"note_id": "12.4", "note": "Prop. 2012/13:1 s. 45.", "claim_from": "12.3", "claim_to": "12.4", "signal": "se", "legal_citations": ["prop. 2012/13:1 s. 45"], "keep": true, "reason": ""}
```

- `note_id`: the id of the sentence line that contains the parenthesis.
- `note`: the text inside the parenthesis, copied exactly.
- `claim_from`, `claim_to`: the first and last sentence id of the claim the note
  supports. `claim_to` is normally `note_id`. The claim is normally that one
  sentence. Start earlier only when the supported statement begins in an
  earlier sentence: the note sentence refers back ("Den innebär …", "Detta
  gäller …"), or the note clearly covers a statement that runs over two or
  three sentences. The range can cross a page. Do not include sentences that
  have their own footnote.
- `signal`: `se`, `jfr`, `se_även` or `none`, from the start of the note.
- `legal_citations`: each legal source in the note, as written: statute
  provisions ("58 kap. 6 b § RB"), cases ("NJA 2004 s. 176", "HFD 2013 ref. 71",
  "Mål C-128/11, p. 52", "Europadomstolens dom X mot Sverige"), preparatory
  works ("prop. 1972:5 s. 159 f.", "SOU 2014:1 s. 30"), EU acts and articles,
  treaties, JO and JK decisions. Do not list literature, reports from
  authorities, websites or news. Empty list if there is none.
- `keep`: true only when all of these hold. Otherwise false, with the first
  failing `reason`:
  1. `legal_citations` is not empty. Otherwise `literature_only`. A note that is
     only "Ibid." or "A.a." gets `ibid`.
  2. The claim states what the law is, or what the cited source says or held.
     A claim about the thesis itself (purpose, method, delimitation,
     structure, what a later chapter does) gets `meta`. The author's own
     opinion, proposal or evaluation gets `author_opinion`.
  3. The claim can be read and checked without the surrounding text: it is a
     full statement, not a heading or a fragment, and any "den/detta/dessa" is
     resolved inside the claim range. Otherwise `fragment`.
  4. A cited legal source can be the authority for the claim. When the claim
     reports what a specific court or case held, the note must cite that case,
     not only a statute or another source. Otherwise `wrong_authority`.
- `reason`: empty string when `keep` is true.

## How to work

Read the whole input file, in parts if needed. Do not skip pages or sample.
Write the output file with one JSON object per line, in input order, and no
other text. When you are done, reply with only: the number of lines written,
the number with `keep: true`, and your exact model ID.
