# Policy: Brand

owner: human:brand-lead
version: 1
applies_to: spec.md (write-time), plan.md (design-time check)

## Why this policy exists
Product names, user-facing copy, colors, and logos written into a spec get copied verbatim into tickets, code, and screenshots, and are expensive to rename once shipped.
This policy puts the brand kit and the brand QA checklist (voice and tone, naming, claims, marks, channel fit) in front of the spec author so the spec carries the approved vocabulary and visual system from the first draft.
It also protects the org's marks and the resource-naming conventions that downstream automation depends on.

## Rules (apply while writing the spec)
1. Read the brand kit at S3 `branding-kit/brand-system.md` before writing any user-facing copy, name, or visual direction; if the object is missing or unreadable, say so in the spec and add a Concern rather than inventing brand values.
2. Every user-facing feature, screen, tool, or tier named in the spec uses the approved product and feature vocabulary from the brand kit; a new name is marked `proposed name` and gets a Concern row for the brand lead.
3. Copy follows the voice and tone attributes in the kit; the spec quotes the attributes it is applying and gives at least one example string per new surface.
4. Colors, typography, spacing tokens, and iconography in the spec reference brand-kit tokens by name; hex values, font names, or icon sets not in the kit are not permitted.
5. Logos, wordmarks, and partner or platform marks appear only in the forms the kit approves (clear space, minimum size, approved backgrounds); the spec never proposes recoloring, cropping, animating, or combining a mark.
6. Third-party trademarks (AWS, Apple, GitHub, Slack, Jira) are written exactly as their owner styles them and are used only to describe compatibility, never to imply endorsement or partnership.
7. Every factual or comparative claim in copy (faster, secure, compliant, unlimited, best) is either backed by a source cited in the spec or removed; superlatives without evidence are not permitted.
8. Required disclosures (beta or preview labels, pricing caveats, AI-generated-content notices, affiliate or sponsorship statements) are written into the copy where the user sees the claim, not only in a footer or settings page.
9. AWS resource names, identifiers, tags, and descriptions use hyphens, never em dashes or en dashes, and follow the `agentcore-hub-*` prefix convention already used by the repo's Lambdas, tables, and rules.
10. User-facing copy uses plain punctuation: no em dashes, no emojis, and no exclamation marks in system messages unless the kit explicitly allows them for that surface.
11. Copy for each channel respects its constraints: UI label length, notification title length, push and email preview truncation, Telegram message limits, and one clear call to action per message.
12. Error, empty, and success messages state what happened and what the user can do next in the brand voice; blame-the-user phrasing and unexplained internal jargon or error codes are not permitted.
13. Terminology is consistent across the whole spec: one term per concept (pick "workflow" or "run", "ticket" or "task") and a short glossary when the spec introduces more than three domain terms.
14. Capitalization, spelling, and regional variant follow the kit's style (sentence case for UI labels, title case for product names, en-US spelling unless localized).
15. Sample data in the spec, mockups, and screenshots uses the kit's approved placeholder names and content; real customer names, real non-partner logos, competitor products, and lorem ipsum are not permitted.

## Questions to answer in the spec
- Which brand-kit version or object date did you read, and which voice and tone attributes did you apply?
- What new names (features, screens, tiers, tools, commands) does the spec introduce, and is each approved or proposed?
- Which visual tokens (color, type, spacing, icon set) does the feature use, and are any outside the kit?
- Do any logos or third-party marks appear, and in which approved form?
- What claims does the copy make, and what evidence supports each?
- Which disclosures or labels (beta, AI-generated, pricing) does the feature require, and where do they appear?
- What are the channel constraints for each message surface (UI, push, email, chat, Telegram), and does the sample copy fit them?
- Which domain terms does the spec introduce, and does the glossary hold exactly one term per concept?

## How to flag a concern
When a rule cannot be satisfied by the spec as written, or needs a judgment call (a new product name, a claim you believe is true but cannot cite, a partner logo the kit does not cover), do not decide it in the spec. Add a row to the spec's `## Concerns` table:

| # | Concern | Policy | Owner | Proposed resolution | Status |

- `#` = next integer in the table, shared across all policies.
- Concern = the rule number and the specific name, string, token, or mark it cannot be satisfied for.
- Policy = `Brand`.
- Owner = `human:brand-lead`.
- Proposed resolution = your proposed name, wording, or treatment, with the closest approved alternative.
- Status = `open`.

The product owner resolves each open concern with the brand lead before engineering starts; the Spec Approval gate stays blocked while any row is `open`. Never silently drop a concern; never resolve one yourself, including by shipping a placeholder name and planning to rename later.
At design time, plan.md re-checks the spec's names, tokens, and sample strings against the design docs and mockups; a mockup that introduces an unlisted color, font, or name is a new open concern.
When the owner resolves a concern, the resolution cell records the approved name or treatment and the kit version it will be added to; the spec author does not write that cell.

## Out of scope for this policy
- Contrast ratios, focus states, motion, and readability of the copy: see `policy-ux`.
- Disclosure wording required by law (consent notices, right-to-withdraw text): see `policy-compliance`.
- Security messaging that could reveal internals in error text: see `policy-security`.
- Pixel-level review of shipped screens against the mockup: brand QA and visual QA at review time.
- Campaign, ad, blog, and social copy produced by the marketing workflow: the brand QA reviewer on those artifacts.
