# Policy: UX

owner: human:design-lead
version: 1
applies_to: spec.md (write-time), plan.md (design-time check)

## Why this policy exists
Accessibility and state coverage are cheapest as requirements and most expensive as review findings against finished screens.
This policy puts the frontend and iOS design leads' checklists (WCAG 2.1 AA, keyboard and focus, contrast, reduced motion, HIG, VoiceOver, Dynamic Type) and the org's baseline for empty, loading, and error states in front of the spec author.
It also draws the line on dark patterns so the spec cannot ask engineering to build one.

## Rules (apply while writing the spec)
1. Every screen or component the spec introduces lists its states: default, loading, empty, error, partial or degraded, success, and disabled; each state has specified copy and a specified next action for the user.
2. Every interactive element is reachable and operable by keyboard alone (Tab order, Enter/Space activation, Escape to dismiss) and the spec names the focus order and where focus lands after modals, deletions, and navigation.
3. Visible focus indicators are required on every focusable element; the spec never removes the outline without specifying a replacement that meets 3:1 contrast against adjacent colors.
4. Text meets WCAG 2.1 AA contrast (4.5:1 normal text, 3:1 large text and UI components) in every theme the product supports, and the spec names the token pairs used.
5. Color is never the only carrier of meaning: status, errors, selection, and charts also use text, icon, or pattern.
6. Every image, icon button, and chart has a specified text alternative; decorative images are marked as such; live-updating regions (streaming output, progress) name their announcement behavior (aria-live politeness or accessibility notification) so screen readers are not flooded.
7. Form inputs have visible labels (a placeholder is not a label), inline error text tied to the field, and errors that say what to fix; the spec lists the validation messages.
8. Motion has a purpose, lasts under 400 ms for UI transitions, and respects `prefers-reduced-motion` and Reduce Motion by falling back to a cross-fade or no motion; auto-playing media, parallax, and flashing above 3 Hz are not permitted.
9. Layouts are specified mobile-first: the spec defines behavior at 320 px width and at the primary tablet and desktop breakpoints, and confirms no horizontal scroll and no content loss at 200% zoom or the largest Dynamic Type size.
10. Touch targets are at least 44x44 pt on iOS (HIG) and at least 24x24 CSS px, 44 px preferred, on web, with spacing so adjacent targets are not mis-tapped.
11. iOS surfaces follow HIG: native navigation patterns, system controls where they exist, full VoiceOver labels, hints, and traits, Dynamic Type through the accessibility sizes, and support for Bold Text, Increase Contrast, and Reduce Transparency.
12. Timing is user-controlled: sessions or dialogs that time out warn first and allow extension; any auto-dismissing message stays for at least 5 seconds and is also available in a persistent location.
13. No dark patterns: no pre-selected upsells, no confirmshaming, no hidden cancel or unsubscribe paths, no fake urgency or scarcity, no flows where exit takes more steps than entry, and no nagging modals that reappear after dismissal.
14. Destructive and irreversible actions require explicit confirmation naming the object, are placed away from primary actions, and offer undo where the system can support it.
15. Error and informational content is honest, actionable, and readable: errors say what failed, whether data was saved, and what to do next, never a raw exception, an HTTP code alone, or blame; all copy uses plain language with front-loaded headings and no hover-only or tooltip-only essential information.

## Questions to answer in the spec
- For each new screen or component, what does the user see and do in the loading, empty, error, partial, success, and disabled states?
- How does a keyboard-only user complete every task in the feature, and where does focus go after each modal, deletion, or navigation?
- Which color token pairs are used for text and controls, and do they meet AA contrast in every supported theme?
- What is announced to screen readers (VoiceOver, NVDA, TalkBack) for images, icon buttons, live regions, and state changes?
- What happens at 320 px width, at 200% zoom, and at the largest Dynamic Type size?
- What motion does the feature use, and what does it do when reduced motion is requested?
- Which actions are destructive or irreversible, and how are they confirmed and undone?
- Does any flow involve choosing, paying, cancelling, or declining, and how does the spec show it is free of dark patterns?

## How to flag a concern
When a rule cannot be satisfied by the spec as written, or needs a judgment call (a brand color pair that fails AA, a third-party widget with no keyboard support, a platform limit on Dynamic Type), do not paper over it. Add a row to the spec's `## Concerns` table:

| # | Concern | Policy | Owner | Proposed resolution | Status |

- `#` = next integer in the table, shared across all policies.
- Concern = the rule number and the specific screen, component, or flow it cannot be satisfied for.
- Policy = `UX`.
- Owner = `human:design-lead`.
- Proposed resolution = the fallback you would propose and which users it still leaves out.
- Status = `open`.

The product owner resolves each open concern with the design lead before engineering starts; the Spec Approval gate stays blocked while any row is `open`. Never silently drop a concern; never resolve one yourself, including by scoping the affected users out of the feature.
At design time, plan.md re-checks the state list, focus order, contrast pairs, and breakpoints against the design docs and mockups; a mockup missing a listed state or failing a listed contrast pair is a new open concern.
When the owner resolves a concern, the resolution cell records the accepted fallback and any follow-up ticket; the spec author does not write that cell.

## Out of scope for this policy
- Color, typography, and iconography choices themselves and brand voice in copy: see `policy-brand`.
- Consent notice content and legally required disclosure text: see `policy-compliance`.
- Error messages that could leak internals: see `policy-security`.
- Verifying the shipped UI against the mockup and running automated accessibility scans (axe, Accessibility Inspector): design leads and QA at review time.
- Localization string catalogues, RTL mirroring, and text-expansion layout tests: engineering checks at plan and review time.
