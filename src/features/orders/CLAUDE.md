# orders/

Order feature slices. Each subdirectory is a vertical slice scoped to one order workflow.

## Subdirectories

| Directory       | What                                                              | When to read                                      |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `create-order/` | Client submits a test request for a `LabService`; writes `Order` + `ClientProfile` in one transaction | Implementing or modifying order creation flow |
