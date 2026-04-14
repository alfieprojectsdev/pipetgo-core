# payments/

Payment feature slices. Each subdirectory is one vertical slice.

## Subdirectories

| Directory    | What                                                                       | When to read                                              |
| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler, credits LabWallet.pendingBalance | Implementing or modifying webhook payment capture or lab wallet crediting |
