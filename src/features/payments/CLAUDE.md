# payments/

Payment feature slices. Each subdirectory is one vertical slice.

## Subdirectories

| Directory    | What                                                                       | When to read                                              |
| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `checkout/`  | Checkout Server Actions — `initiateCheckout` (Xendit invoice) and `initiateVaCheckout` (PESONet FVA); both guard, call Xendit, write Transaction, and redirect | Implementing or modifying the PAYMENT_PENDING pay flow for either payment method |
| `payouts/`   | Xendit settlement webhook — confirms commission split settled into PipetGo account, transitions Payout QUEUED -> COMPLETED, moves Payout.platformFee from LabWallet.pendingBalance to availableBalance; integration tests in `payouts/__tests__/` | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests |
| `webhooks/`  | Xendit webhook slices — invoice route + provider-agnostic handlers + `xendit-va/` FVA sub-slice; `handlers.ts` shared by both routes; integration tests in `webhooks/__tests__/` and `webhooks/xendit-va/__tests__/` | Implementing or modifying webhook payment capture, adding a new webhook provider, or running capture tests |
