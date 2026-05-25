/**
 * Per-provider inbound webhook authentication verifiers.
 *
 * This is the single location for webhook auth across all providers. Each verifier
 * is a named function — no factory or interface — because provider auth strategies
 * are structurally different (static token vs HMAC) and an abstraction is not
 * justified until a second provider is live. (ref: AD-002, rejected-alternative: PaymentProvider factory)
 *
 * Allowed imports: node:crypto and next/server only. Must not import from @/features/,
 * @/domain/, or @prisma/client. (ref: DL-018)
 *
 * Leaf module — route.ts is the only consumer. handlers.ts, src/domain/, and any
 * __tests__ other than this module's own unit tests must never import from here.
 * (ref: DL-019)
 */
import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'

/**
 * Verifies a Xendit webhook x-callback-token header against the provided secret.
 *
 * Returns false immediately when secret is empty string — defense-in-depth guard
 * so a misconfigured env var cannot accidentally pass verification. (ref: DL-014)
 *
 * Buffer length check is a load-bearing precondition for crypto.timingSafeEqual:
 * equal-length buffers are required or timingSafeEqual throws RangeError. The check
 * is not an optimisation — it is a correctness requirement. (ref: DL-008)
 *
 * Accepts (req, secret) so callers pass the env-read secret explicitly — coupling
 * route.ts env reads to this verifier would make unit-testing without env stubs
 * impossible. (ref: DL-004)
 */
export function verifyXenditToken(req: NextRequest, secret: string): boolean {
  if (!secret) return false
  const token = req.headers.get('x-callback-token') ?? ''
  const tokenBuf = Buffer.from(token)
  const secretBuf = Buffer.from(secret)
  return (
    tokenBuf.length === secretBuf.length &&
    crypto.timingSafeEqual(tokenBuf, secretBuf)
  )
}

/**
 * Verifies a PayMongo webhook signature header against the provided secret.
 *
 * Header format: t={timestamp},te={testEnvSig},li={liveEnvSig}
 * `rawBody` must be the raw request body text read before `JSON.parse` —
 * re-serializing a parsed body breaks the HMAC-SHA256 comparison.
 * Signed payload: {timestamp}.{rawBody}
 * Algorithm: HMAC-SHA256, constant-time comparison.
 * Timestamp tolerance: 300 seconds (ref: DL-013).
 *
 * API contract anchor: https://developers.paymongo.com/docs/webhooks (ref: DL-013)
 *
 * Not wired to any route until T-17 (PayMongo migration).
 */
export function verifyPayMongoHmac(
  rawBody: string,
  header: string,
  secret: string,
): boolean {
  if (!secret || !header) return false
  const parts: Record<string, string> = {}
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq !== -1) parts[part.slice(0, eq)] = part.slice(eq + 1)
  }
  const timestamp = parts['t']
  const sigClaim = parts['li'] ?? parts['te']
  if (!timestamp || !sigClaim) return false
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts)) return false
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > 300) return false
  const signed = `${timestamp}.${rawBody}`
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex')
  const expectedBuf = Buffer.from(expected)
  const claimBuf = Buffer.from(sigClaim)
  return (
    expectedBuf.length === claimBuf.length &&
    crypto.timingSafeEqual(expectedBuf, claimBuf)
  )
}

/**
 * Verifies a HitPay webhook signature against the provided salt.
 *
 * Algorithm: HMAC-SHA256 over rawBody with salt, constant-time comparison.
 *
 * ASSUMPTION_UNVALIDATED: the HitPay algorithm described here is pending sandbox
 * verification against the HitPay webhook spec before T-17 wires this to a route.
 * API contract anchor: https://docs.hitpayapp.com/api-reference/webhooks (ref: DL-020)
 *
 * Not wired to any route until a HitPay integration ticket is scheduled.
 */
export function verifyHitPayHmac(
  rawBody: string,
  header: string,
  salt: string,
): boolean {
  if (!salt || !header) return false
  const expected = crypto.createHmac('sha256', salt).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected)
  const headerBuf = Buffer.from(header)
  return (
    expectedBuf.length === headerBuf.length &&
    crypto.timingSafeEqual(expectedBuf, headerBuf)
  )
}
