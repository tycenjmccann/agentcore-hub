# Design excerpt: list endpoint pagination contract (sample-service)

- `page` is 1-based; `pageSize` is clamped to 1..100.
- Page N of size S returns items with zero-based indices `[(N-1)*S, N*S)` —
  i.e. exactly S items unless it is the final partial page.
- `total` always reflects the unfiltered count so clients can render page
  controls.
- Out-of-range pages return an empty `items` array with the correct `total`,
  not an error.
