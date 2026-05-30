'use client'

import Link from 'next/link'
import { type KycStatus } from '@prisma/client'
import type { LabQueueDTO } from './page'

// KYC_STATUS_BADGE is copied from the labs/ slice rather than imported.
// VSA (ADR-001) prohibits cross-slice UI imports. `satisfies Record<KycStatus,…>`
// makes a missing enum member a compile-time error. (ref: DL-009)
const KYC_STATUS_BADGE = {
  PENDING:   { label: 'Not started',    className: 'bg-gray-200 text-gray-700' },
  SUBMITTED: { label: 'Pending review', className: 'bg-yellow-200 text-yellow-800' },
  APPROVED:  { label: 'Verified',       className: 'bg-green-200 text-green-800' },
  REJECTED:  { label: 'Rejected',       className: 'bg-red-200 text-red-700' },
} as const satisfies Record<KycStatus, { label: string; className: string }>

export function AdminKycQueueUi({ queue }: { queue: LabQueueDTO[] }) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">KYC Review Queue</h1>
          <p className="mt-1 text-sm text-gray-500">
            {queue.length === 0
              ? 'No submissions awaiting review.'
              : `${queue.length} submission${queue.length === 1 ? '' : 's'} awaiting review.`}
          </p>
        </div>

        {queue.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Lab
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Submitted
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {queue.map((lab) => {
                  const badge = KYC_STATUS_BADGE[lab.kycStatus]
                  return (
                    <tr key={lab.id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {lab.name}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {lab.ownerEmail}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(lab.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <Link
                          href={`/dashboard/admin/kyc/${lab.id}`}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
