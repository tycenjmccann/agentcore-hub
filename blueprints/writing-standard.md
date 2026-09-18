# Blueprint: Writing Standard

Every markdown deliverable under `workflows/{workflow_id}/shared/` is read by
someone who has to decide or act in under a minute, usually on a phone. This
standard is how you write for that reader. The write tool
(`S3Storage___write_object`, `WorkflowOutput___save_design_doc`) refuses a
registered deliverable that breaks the structural rules below and tells you
which rule; fix the document, do not rename the file to dodge the check.

## The one rule
Answer first. The first section of every document states the conclusion in
one to three sentences: the decision, the verdict, the outcome, the status.
Everything after it exists only to support that sentence. A reader who stops
after the first section must already know what you concluded.

## Structure (pyramid)
1. `# Title` on the first line. Name the thing and its ticket: `# Merge brief: PR #637 (TEAM-4760)`.
2. The family's sections as `##` headings, in the template's order, exact
   text. Load the template for your deliverable
   (`load_blueprint("template-<family>")`); it lists the reader's questions
   and each heading answers one of them.
3. Three or four supporting points per section, each one idea, ordered by
   what the reader needs first (severity, then time, then structure).
4. Extra `##` sections only after the template's sections, as appendix.
   Detail the reader may never need goes there or into a linked artifact.

## Sentences
- Lead sentence of each section carries the point; the rest is evidence.
- One idea per sentence, active voice, about 20 words. Cut adjectives and
  qualifiers ("robust", "comprehensive", "significantly", "it should be noted").
- Counts, not adjectives: "7 Playwright tests passed", never "extensive tests".
- Name what a thing IS before its symbol: "the ledger table
  (`agentcore-hub-si-ledger`)". A bare identifier is not an explanation.
- Prose for argument, a table for comparable rows, a list for parallel items.
  Never a list of one. Never a paragraph inside a bullet.

## Formatting the renderer can show
- Headings are `#`/`##`/`###` only. No ALL-CAPS heading, no bold line used
  as a heading, no `•` bullets (the hub renderer flattens them). Use `-`.
- No em dashes inside prose (`,` or a new sentence). Hyphens in names are fine.
- Links: the artifact key or PR url, once, where the reader needs it.

## What "done" looks like
Read only your title and first section. If the reader could act on that
alone, the document is right. If they would have to keep reading to find the
point, rewrite the first section. Length is not the target; a 30-line brief
that answers the questions beats a 300-line one that lists everything.
