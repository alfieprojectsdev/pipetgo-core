/**
 * Unit tests for validStatusTransitions and isValidStatusTransition.
 *
 * Covers the 3 new edges added in T-19 (COMPLETED->DISPUTED, DISPUTED->COMPLETED,
 * DISPUTED->REFUND_PENDING) and asserts that invalid edges (DISPUTED->CANCELLED,
 * COMPLETED->REFUNDED) are rejected by the single enforcement point.
 */
import { describe, it, expect } from 'vitest'
import { OrderStatus } from '@prisma/client'
import { validStatusTransitions, isValidStatusTransition } from '../state-machine'

describe('validStatusTransitions — T-19 new edges', () => {
  it('COMPLETED allows DISPUTED (new T-19 edge)', () => {
    expect(validStatusTransitions[OrderStatus.COMPLETED]).toContain(OrderStatus.DISPUTED)
  })

  it('DISPUTED allows COMPLETED (new T-19 edge)', () => {
    expect(validStatusTransitions[OrderStatus.DISPUTED]).toContain(OrderStatus.COMPLETED)
  })

  it('DISPUTED allows REFUND_PENDING (new T-19 edge)', () => {
    expect(validStatusTransitions[OrderStatus.DISPUTED]).toContain(OrderStatus.REFUND_PENDING)
  })

  it('COMPLETED still allows REFUND_PENDING (existing edge preserved)', () => {
    expect(validStatusTransitions[OrderStatus.COMPLETED]).toContain(OrderStatus.REFUND_PENDING)
  })

  it('DISPUTED has exactly 2 outgoing edges — no CANCELLED edge', () => {
    expect(validStatusTransitions[OrderStatus.DISPUTED]).toHaveLength(2)
    expect(validStatusTransitions[OrderStatus.DISPUTED]).not.toContain(OrderStatus.CANCELLED)
  })
})

describe('isValidStatusTransition — T-19 valid edges', () => {
  it('accepts COMPLETED -> DISPUTED', () => {
    expect(isValidStatusTransition(OrderStatus.COMPLETED, OrderStatus.DISPUTED)).toBe(true)
  })

  it('accepts DISPUTED -> COMPLETED', () => {
    expect(isValidStatusTransition(OrderStatus.DISPUTED, OrderStatus.COMPLETED)).toBe(true)
  })

  it('accepts DISPUTED -> REFUND_PENDING', () => {
    expect(isValidStatusTransition(OrderStatus.DISPUTED, OrderStatus.REFUND_PENDING)).toBe(true)
  })
})

describe('isValidStatusTransition — T-19 invalid edges rejected', () => {
  it('rejects DISPUTED -> CANCELLED (out of scope, no regulatory basis)', () => {
    expect(isValidStatusTransition(OrderStatus.DISPUTED, OrderStatus.CANCELLED)).toBe(false)
  })

  it('rejects COMPLETED -> REFUNDED (must go via REFUND_PENDING first)', () => {
    expect(isValidStatusTransition(OrderStatus.COMPLETED, OrderStatus.REFUNDED)).toBe(false)
  })

  it('rejects DISPUTED -> REFUNDED (no direct refund edge from DISPUTED)', () => {
    expect(isValidStatusTransition(OrderStatus.DISPUTED, OrderStatus.REFUNDED)).toBe(false)
  })

  it('rejects DISPUTED -> CANCELLED (no cancellation-after-dispute path)', () => {
    expect(isValidStatusTransition(OrderStatus.DISPUTED, OrderStatus.CANCELLED)).toBe(false)
  })
})
