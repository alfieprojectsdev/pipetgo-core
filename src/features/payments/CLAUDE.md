# payments/

Payment feature slices. Each subdirectory is one vertical slice.

## Subdirectories

| Directory    | What                                                                       | When to read                                              |
| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
| `payouts/`   | Xendit settlement webhook — confirms commission split settled into PipetGo account, transitions Payout QUEUED -> COMPLETED, moves Payout.platformFee from LabWallet.pendingBalance to availableBalance; integration tests in `payouts/__tests__/` | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests |
| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler; integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture or payment capture tests |
