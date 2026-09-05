# Design excerpt: notification preferences (sample-service)

## Contract

- Users choose a digest frequency per notification category: `immediate`,
  `daily`, or `weekly`.
- **Default for every category is `daily`** — immediate is opt-in, chosen
  explicitly, because launch feedback showed immediate notifications were the
  top uninstall driver.
- Every digest email MUST include an unsubscribe link in the footer that
  one-click disables that category (compliance requirement from the legal
  review).
- Preference changes take effect on the next digest cycle; no retroactive
  resend.
