'use client'

/**
 * Client dispute form. Submits to openDispute via useActionState and renders
 * every error branch returned by the action — no silent failures.
 * completedAt is a pre-serialized ISO string from the RSC page DTO.
 */
import { useActionState } from 'react'
import { openDispute } from './action'
import type { DisputePageDTO } from './page'

export function DisputeForm({ dto }: { dto: DisputePageDTO }) {
  const [state, formAction, isPending] = useActionState(openDispute, null)

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-4">
          <a href={`/dashboard/orders/${dto.orderId}`} className="text-sm text-blue-600 hover:underline">
            ← Back to order
          </a>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Dispute Order</h1>
        <p className="text-sm text-gray-500 mb-6">
          {dto.serviceName} — {dto.labName}
        </p>

        <div className="bg-white rounded-lg shadow p-6">
          <form action={formAction}>
            <input type="hidden" name="orderId" value={dto.orderId} />

            <div className="mb-4">
              <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-1">
                Reason for dispute <span className="text-red-500">*</span>
              </label>
              <textarea
                id="reason"
                name="reason"
                rows={5}
                required
                className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Describe the issue with this order…"
              />
            </div>

            {state?.message && (
              <p className="text-sm text-red-600 mb-3">{state.message}</p>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {isPending ? 'Submitting dispute…' : 'Submit dispute'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
