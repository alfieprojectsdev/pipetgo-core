'use client'
// Queue UI for admin/accreditation-review. All queue entries are isVerified=false;
// badge key derived from whether accreditationRejectionReason is non-null.

import Link from 'next/link'
import type { AccreditationQueueDTO } from './page'

// Status display for labs in the accreditation queue.
// All queue entries are isVerified=false; accreditationRejectionReason non-null
// means a prior review ended in rejection (previously rejected); null means
// no decision has been recorded yet (awaiting first review).
const ACCREDITATION_STATUS_BADGE = {
  pending:  { label: 'Awaiting review', className: 'bg-yellow-200 text-yellow-800' },
  rejected: { label: 'Previously rejected', className: 'bg-red-200 text-red-700' },
} as const satisfies Record<'pending' | 'rejected', { label: string; className: string }>

export function AdminAccreditationQueueUi({ queue }: { queue: AccreditationQueueDTO[] }) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Accreditation Review Queue</h1>
          <p className="mt-1 text-sm text-gray-500">
            {queue.length === 0
              ? 'No certificates awaiting review.'
              : `${queue.length} lab${queue.length === 1 ? '' : 's'} awaiting accreditation review.`}
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
                    Registered
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {queue.map((lab) => {
                  const badgeKey = lab.accreditationRejectionReason !== null ? 'rejected' : 'pending'
                  const badge = ACCREDITATION_STATUS_BADGE[badgeKey]
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
                          href={`/dashboard/admin/accreditation/${lab.id}`}
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
