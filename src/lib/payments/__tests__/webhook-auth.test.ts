import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'
import { verifyXenditToken, verifyPayMongoHmac, verifyHitPayHmac } from '../webhook-auth'

function makeRequest(headers: Record<string, string>): NextRequest {
  return new Request('https://example.com', { headers }) as unknown as NextRequest
}

describe('verifyXenditToken', () => {
  it('returns true for a matching token and secret', () => {
    const secret = 'my-xendit-secret'
    const req = makeRequest({ 'x-callback-token': secret })
    expect(verifyXenditToken(req, secret)).toBe(true)
  })

  it('returns false for a mismatched equal-length token', () => {
    const secret = 'my-xendit-secret'
    const wrong = 'my-xendit-WRONG!'
    const req = makeRequest({ 'x-callback-token': wrong })
    expect(verifyXenditToken(req, secret)).toBe(false)
  })

  it('returns false when secret is empty string regardless of header value', () => {
    const req = makeRequest({ 'x-callback-token': 'any-token-value' })
    expect(verifyXenditToken(req, '')).toBe(false)
  })

  it('returns false for a different-length token without throwing RangeError', () => {
    const secret = 'short'
    const req = makeRequest({ 'x-callback-token': 'much-longer-token-value' })
    expect(() => verifyXenditToken(req, secret)).not.toThrow()
    expect(verifyXenditToken(req, secret)).toBe(false)
  })
})

describe('verifyPayMongoHmac', () => {
  it('returns true for a known-good HMAC', () => {
    const secret = 'paymongo-secret'
    const rawBody = '{"event":"payment.paid"}'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signed = `${timestamp}.${rawBody}`
    const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex')
    const header = `t=${timestamp},li=${sig}`
    expect(verifyPayMongoHmac(rawBody, header, secret)).toBe(true)
  })

  it('returns false when body is mutated', () => {
    const secret = 'paymongo-secret'
    const rawBody = '{"event":"payment.paid"}'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signed = `${timestamp}.${rawBody}`
    const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex')
    const header = `t=${timestamp},li=${sig}`
    expect(verifyPayMongoHmac('{"event":"payment.failed"}', header, secret)).toBe(false)
  })

  it('returns false when signature header is empty', () => {
    const rawBody = '{"event":"payment.paid"}'
    expect(verifyPayMongoHmac(rawBody, '', 'paymongo-secret')).toBe(false)
  })

  it('returns false when signature header is missing sig fields', () => {
    const rawBody = '{"event":"payment.paid"}'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const header = `t=${timestamp}`
    expect(verifyPayMongoHmac(rawBody, header, 'paymongo-secret')).toBe(false)
  })

  it('returns false when timestamp is older than 300s tolerance', () => {
    const secret = 'paymongo-secret'
    const rawBody = '{"event":"payment.paid"}'
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301)
    const signed = `${staleTimestamp}.${rawBody}`
    const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex')
    const header = `t=${staleTimestamp},li=${sig}`
    expect(verifyPayMongoHmac(rawBody, header, secret)).toBe(false)
  })
})

describe('verifyHitPayHmac', () => {
  it('returns true for a known-good HMAC over rawBody', () => {
    const salt = 'hitpay-salt'
    const rawBody = 'payment_id=abc&status=completed'
    const sig = crypto.createHmac('sha256', salt).update(rawBody).digest('hex')
    expect(verifyHitPayHmac(rawBody, sig, salt)).toBe(true)
  })

  it('returns false when body is mutated', () => {
    const salt = 'hitpay-salt'
    const rawBody = 'payment_id=abc&status=completed'
    const sig = crypto.createHmac('sha256', salt).update(rawBody).digest('hex')
    expect(verifyHitPayHmac('payment_id=abc&status=failed', sig, salt)).toBe(false)
  })
})
