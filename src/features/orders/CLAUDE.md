# orders/

Order feature slices. Each subdirectory is a vertical slice scoped to one order workflow.

## Subdirectories

| Directory       | What                                                              | When to read                                      |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `create-order/` | Client submits a test request for a `LabService`; writes `Order` + `ClientProfile` in one transaction | Implementing or modifying order creation flow |
| `handle-payment-captured/` | Handles PaymentCapturedEvent from webhook — advances Order status from PAYMENT_PENDING to ACKNOWLEDGED | Implementing or modifying post-payment order advancement |
| `lab-fulfillment/` | LAB_ADMIN views ACKNOWLEDGED/IN_PROGRESS orders, starts processing (ACKNOWLEDGED->IN_PROGRESS), and completes with notes (IN_PROGRESS->COMPLETED) | Implementing or modifying lab-side order fulfillment |
| `quote-provide/`   | LAB_ADMIN views a QUOTE_REQUESTED order and provides a price quote (QUOTE_REQUESTED→QUOTE_PROVIDED); dispatched from the app router | Implementing or modifying the quote submission flow |
| `order-detail/`    | CLIENT views a single order — status badge, service/lab/amount/contact summary, status timeline; T-07 adds Accept/Reject actions for QUOTE_PROVIDED orders | Implementing or modifying the client order detail view |
