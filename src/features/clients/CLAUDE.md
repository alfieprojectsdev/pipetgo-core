# clients/

Client feature slices. Each subdirectory is a vertical slice scoped to one
client workflow. Per VSA boundary rules (ADR-001), slices under clients/ must
not import UI components from other feature slices.

## Files

No files at this level.

## Subdirectories

| Directory   | What                                                              | When to read                                          |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `dashboard/`| Client dashboard — CLIENT order listing, flat table, newest-first | Implementing or modifying the client dashboard page  |
