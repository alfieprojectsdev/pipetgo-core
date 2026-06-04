import { describe, it, expect } from 'vitest'
import { DISPUTE_WINDOW_DAYS, isWithinDisputeWindow } from '../dispute'

const DAY_MS = 24 * 60 * 60 * 1000
const completedAt = new Date('2026-05-01T00:00:00Z')

describe('isWithinDisputeWindow', () => {
  it('exports a 14-day window', () => {
    expect(DISPUTE_WINDOW_DAYS).toBe(14)
  })

  it('is within window the instant after completion', () => {
    expect(isWithinDisputeWindow(completedAt, new Date(completedAt.getTime() + 1000))).toBe(true)
  })

  it('is within window at exactly DISPUTE_WINDOW_DAYS', () => {
    const now = new Date(completedAt.getTime() + DISPUTE_WINDOW_DAYS * DAY_MS)
    expect(isWithinDisputeWindow(completedAt, now)).toBe(true)
  })

  it('is out of window just past DISPUTE_WINDOW_DAYS', () => {
    const now = new Date(completedAt.getTime() + DISPUTE_WINDOW_DAYS * DAY_MS + 1)
    expect(isWithinDisputeWindow(completedAt, now)).toBe(false)
  })

  it('rejects a future completedAt (clock skew / malformed timestamp)', () => {
    const now = new Date(completedAt.getTime() - 1000)
    expect(isWithinDisputeWindow(completedAt, now)).toBe(false)
  })
})
