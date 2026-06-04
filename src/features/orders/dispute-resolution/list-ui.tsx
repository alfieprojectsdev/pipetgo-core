'use client'

/**
 * Admin dispute list. Consumes pre-serialized DisputedOrderDTO (string dates/amounts).
 * Dates rendered with fixed locale + timeZone ('en-PH', 'Asia/Manila') —
 * bare toLocaleString() is forbidden in client components (CLAUDE.md discipline).
 */
import Link from 'next/link'
import type { DisputedOrderDTO } from './page'

export function DisputeListUi({ rows }: { rows: DisputedOrderDTO[] }) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Disputes</h1>
          <p className="mt-1 text-sm text-gray-500">
            {rows.length === 0
              ? 'No open disputes.'
              : `${rows.length} open dispute${rows.length === 1 ? '' : 's'}.`}
          </p>
        </div>

        {rows.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lab</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Opened</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-700">
                      {row.id.slice(0, 12)}&hellip;
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.labName}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.clientEmail}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.quotedPrice ?? '—'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.disputeOpenedAt))}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <Link
                        href={`/dashboard/admin/disputes/${row.id}`}
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        Resolve
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
