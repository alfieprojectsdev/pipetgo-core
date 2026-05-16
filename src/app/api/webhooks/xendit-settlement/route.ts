// App Router wiring for Xendit settlement webhook. ADR-001 slice boundary: logic lives
// in src/features/payments/payouts/route.ts; this file is the app-router entry point only.
// Separate route from the invoice webhook (src/app/api/webhooks/xendit/) — one route per
// provider event type keeps slice boundaries clean. (ref: DL-003)
// Register this URL in the Xendit dashboard as the settlement webhook endpoint.
export { POST } from '@/features/payments/payouts/route'
