# Policy: Compliance

owner: human:compliance-lead
version: 1
applies_to: spec.md (write-time), plan.md (design-time check)

## Why this policy exists
Personal data collected without a lawful basis, a retention rule, or a deletion path cannot be fixed after launch without deleting user data or re-consenting users.
This policy moves the compliance review's checks (data inventory, legal basis, user rights, consent, retention and deletion, cross-border transfer, documentation updates) to the moment the spec is written, so the spec itself is the record of processing.
It also covers the regulatory side of shipping to more than one locale, which the localization review otherwise catches late.

## Rules (apply while writing the spec)
1. The spec contains a data inventory table: every personal-data field collected, derived, or received, with its source, purpose, storage location, and whether it is special-category (health, biometric, financial, children, precise location).
2. Every purpose in the inventory names its legal basis (consent, contract, legitimate interest, legal obligation) and the regulation(s) that apply to the affected users (GDPR, UK GDPR, CCPA/CPRA, COPPA, HIPAA, PCI DSS); "we might need it later" is not a purpose.
3. Any new collection, or reuse of existing data for a new purpose, specifies the consent or notice moment: where in the flow, what the user sees, how the choice is recorded, and how it is withdrawn.
4. Consent is opt-in, granular per purpose, and not bundled with terms acceptance or a required step; pre-ticked boxes and continue-means-consent are not permitted.
5. Every personal-data field has a retention period with a number and a trigger (for example "90 days after account closure") and a deletion mechanism (TTL, scheduled job, cascade) that also reaches backups, caches, logs, analytics, and vendor copies.
6. The spec states how a user exercises access, correction, deletion, portability, and objection or opt-out for this data, and which existing endpoint or process handles each; a missing path is a Concern, not a TODO.
7. Deletion requests complete within the regulatory window (30 days GDPR, 45 days CCPA) and the spec names anything retained under a legal-obligation exception and why.
8. Every processor or vendor that receives personal data (analytics, LLM provider, email, CRM, support tooling) is named with the data it gets, the DPA status, and the sub-processor terms.
9. Personal data crossing a jurisdictional boundary (region choice, vendor location, model endpoint region) names the transfer mechanism (SCCs, adequacy decision, DPF) or keeps the data in region.
10. Personal data sent to an LLM or used to train, fine-tune, or evaluate a model is called out explicitly, with the minimization applied, whether prompts and outputs are stored, and the user opt-out.
11. Sale or sharing of personal data for cross-context advertising is either stated as not occurring or accompanied by a Do Not Sell/Share control and Global Privacy Control signal handling.
12. Features that could reach users under 13 (or 16 where applicable) state the age-gating approach and parental-consent flow, or state why the audience excludes minors.
13. The spec lists the documentation updates it triggers: ROPA entry, DPIA (required for large-scale profiling, special-category data, or new tracking technology), privacy policy text, cookie notice, and DPA amendments, each with an owner.
14. Marketing or transactional messaging names the channel law it must satisfy (CAN-SPAM, CASL, TCPA, PECR) and the unsubscribe or opt-out mechanism.
15. Any feature displayed in a regulated locale states locale-specific requirements (mandatory disclosures, currency and tax display, right-to-withdraw text, local accessibility law) alongside the plan for translated strings.

## Questions to answer in the spec
- What personal data is collected, derived, or received, from whom, and what is the legal basis for each purpose?
- Where and when does the user learn about this processing and, where consent is the basis, give and withdraw it?
- How long is each field kept, what deletes it, and does deletion reach backups, logs, analytics, and vendors?
- How does a user access, correct, delete, or export this data, and which team or system fulfils the request within the deadline?
- Which third parties, including AI/LLM providers, receive personal data, under what agreement, and in which region?
- Does personal data leave the user's jurisdiction, and if so under which transfer mechanism?
- Could minors use this feature, and how is that handled?
- Which compliance documents (ROPA, DPIA, privacy policy, cookie notice, DPA) need updating before launch, and who owns each update?

## How to flag a concern
When a rule cannot be satisfied by the spec as written, or needs a judgment call (for example whether legitimate interest covers a new analytics purpose, or whether a DPIA is required), do not decide it in the spec. Add a row to the spec's `## Concerns` table:

| # | Concern | Policy | Owner | Proposed resolution | Status |

- `#` = next integer in the table, shared across all policies.
- Concern = the rule number and the specific data field, purpose, or vendor it cannot be satisfied for.
- Policy = `Compliance`.
- Owner = `human:compliance-lead`.
- Proposed resolution = the basis, retention, or mechanism you would propose, with the regulation it relies on.
- Status = `open`.

The product owner resolves each open concern with the compliance lead before engineering starts; the Spec Approval gate stays blocked while any row is `open`. Never silently drop a concern; never resolve one yourself, and never downgrade a field's classification or narrow the stated purpose to make a rule stop applying.
At design time, plan.md re-checks the inventory against the actual tables, queues, logs, and vendor calls in the architecture; any personal data the design adds that the spec did not list is a new open concern.
When the owner resolves a concern, the resolution cell records the decision and the document it was recorded in (ROPA row, DPIA section, legal memo); the spec author does not write that cell.

## Out of scope for this policy
- Encryption, access control, secrets, and abuse prevention for the same data: see `policy-security`.
- Consent UI clarity, dark patterns, and readability of notices: see `policy-ux`.
- Wording and tone of privacy-facing copy: see `policy-brand`.
- Contract clause review (DPA language, sub-processor terms) for a specific vendor agreement: the privacy reviewer and legal approver in the contract workflow.
- String catalogues, pluralization, and RTL layout for localization: engineering checks at plan and review time, not spec rules.
