/**
 * Settlement processor for Xendit sub-account split settlement webhooks.
 *
 * processSettlement runs all DB writes inside a single Prisma $transaction.
 * Any throw at any step rolls back all writes; Xendit retries on 500.
 */
import { PayoutStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { XenditSettlementPayload } from './types'

/**
 * Transitions a QUEUED Payout to COMPLETED and atomically moves Payout.platformFee
 * from LabWallet.pendingBalance to LabWallet.availableBalance.
 *
 * Idempotent: duplicate delivery (externalPayoutId already set, status COMPLETED) returns early.
 * Orphan-tolerant: no Payout found for the settlement ID or orderId returns early.
 * Throws for unexpected Payout statuses (PROCESSING/FAILED) — contract violation.
 * Throws if LabWallet.pendingBalance would go negative — upstream invariant violated.
 */
export async function processSettlement(payload: XenditSettlementPayload): Promise<void> {
  console.info(`[processSettlement] enter id=${payload.id} external_id=${payload.external_id}`)

  await prisma.$transaction(async (tx) => {
    // Step 1: idempotency check — look up by externalPayoutId (@unique, Implementation Discipline).
    let payout = await tx.payout.findUnique({
      where: { externalPayoutId: payload.id },
    })

    if (payout) {
      if (payout.status === PayoutStatus.COMPLETED) {
        console.info(`[processSettlement] idempotent no-op id=${payload.id}`)
        return
      }
      // PROCESSING and FAILED are contract violations — no current slice writes these on the
      // settlement path. Encountering them means another writer mutated Payout outside the
      // documented flow. Throw per Implementation Discipline (unhandled enum branches must throw). (ref: DL-008)
      if (payout.status === PayoutStatus.PROCESSING || payout.status === PayoutStatus.FAILED) {
        throw new Error(
          `processSettlement: contract violation — Payout ${payout.id} has status ${payout.status} which is unexpected for settlement id=${payload.id}`,
        )
      }
      // payout.status === QUEUED, externalPayoutId already set — concurrent delivery; proceed.
    }

    // Step 2: first-delivery lookup — find QUEUED Payout with no externalPayoutId by orderId. (ref: DL-005)
    // State-machine invariant: completeOrder (T-09) is called exactly once per Order (terminal
    // COMPLETED transition). At most one QUEUED Payout per orderId can exist with a null
    // externalPayoutId at any time. findFirst is safe here because uniqueness is enforced by the
    // (orderId, status=QUEUED, externalPayoutId=null) compound predicate + state machine, not a
    // single column — Implementation Discipline's findUnique-on-@unique rule does not apply.
    if (!payout) {
      payout = await tx.payout.findFirst({
        where: {
          orderId: payload.external_id,
          status: PayoutStatus.QUEUED,
          externalPayoutId: null,
        },
      })

      if (!payout) {
        // Orphan tolerance — Xendit may deliver for settlements not in our DB.
        // Return 200 so Xendit does not retry indefinitely. Mirrors processPaymentCapture
        // orphan-tolerance pattern. (ref: DL-009)
        console.info(`[processSettlement] orphan tolerance id=${payload.id} external_id=${payload.external_id}`)
        return
      }
    }

    // Step 2.5: explicit wallet read — absence means M-0 invariant was violated.
    // findUnique on labId (@unique per schema.prisma:299) per Implementation Discipline. (ref: R-005)
    // Explicit read throws a typed Error instead of relying on an opaque Prisma update-not-found error.
    const currentWallet = await tx.labWallet.findUnique({
      where: { labId: payout.labId },
    })

    if (!currentWallet) {
      throw new Error(
        `LabWallet missing for lab ${payout.labId}: Payout exists without LabWallet row — M-0 invariant violated`,
      )
    }

    // Step 3: negative-balance guard — throw on contract violation, never clamp. (ref: DL-007)
    // Negative result means M-0 credit was missed or idempotency guard was bypassed.
    // Clamping hides the bug and corrupts the ledger silently per Implementation Discipline.
    const newPending = currentWallet.pendingBalance.sub(payout.platformFee)
    if (newPending.isNegative()) {
      throw new Error(
        `LabWallet.pendingBalance would go negative for lab ${payout.labId}: current=${currentWallet.pendingBalance} debit=${payout.platformFee}`,
      )
    }

    // Step 4: mark Payout COMPLETED; externalPayoutId=null filter prevents double-settlement
    // under concurrent first-delivery: if two requests reach this point simultaneously,
    // only the first updateMany matches (externalPayoutId still null, count=1); the second
    // finds externalPayoutId already written (count=0) and returns early. Xendit retries
    // the loser, which then finds the COMPLETED Payout in Step 1 and returns early.
    const updateResult = await tx.payout.updateMany({
      where: { id: payout.id, externalPayoutId: null },
      data: {
        status: PayoutStatus.COMPLETED,
        externalPayoutId: payload.id,
        completedAt: new Date(),
      },
    })

    if (updateResult.count === 0) {
      return
    }

    // Step 5: atomic balance move — both deltas in one update call.
    await tx.labWallet.update({
      where: { labId: payout.labId },
      data: {
        pendingBalance: { decrement: payout.platformFee },
        availableBalance: { increment: payout.platformFee },
      },
    })
  })
}
