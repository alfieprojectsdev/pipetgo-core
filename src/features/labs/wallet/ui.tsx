'use client'

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import type { LabWalletDTO, LabPayoutDTO } from './page'

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  QUEUED:     { label: 'Queued',     className: 'bg-gray-100 text-gray-700' },
  PROCESSING: { label: 'Processing', className: 'bg-yellow-100 text-yellow-800' },
  COMPLETED:  { label: 'Completed',  className: 'bg-green-100 text-green-800' },
  FAILED:     { label: 'Failed',     className: 'bg-red-100 text-red-700' },
}

function BalanceCard({
  label,
  amount,
  currency,
}: {
  label: string
  amount: string
  currency: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-gray-500">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold text-gray-900">
          {currency} {amount}
        </p>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGE[status] ?? { label: status, className: 'bg-gray-100 text-gray-700' }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
    >
      {badge.label}
    </span>
  )
}

type LabWalletUIProps = {
  wallet: LabWalletDTO
  payouts: LabPayoutDTO[]
}

export function LabWalletUI({ wallet, payouts }: LabWalletUIProps) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Wallet</h1>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-8">
          <BalanceCard
            label="Pending"
            amount={wallet.pendingBalance}
            currency={wallet.currency}
          />
          <BalanceCard
            label="Available"
            amount={wallet.availableBalance}
            currency={wallet.currency}
          />
          <BalanceCard
            label="Withdrawn Total"
            amount={wallet.withdrawnTotal}
            currency={wallet.currency}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Payout History</CardTitle>
          </CardHeader>
          <CardContent>
            {payouts.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">No payouts yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-600">
                    <th className="pb-2 pr-4 font-medium">Payout ID</th>
                    <th className="pb-2 pr-4 font-medium">Order</th>
                    <th className="pb-2 pr-4 font-medium">Gross</th>
                    <th className="pb-2 pr-4 font-medium">Fee</th>
                    <th className="pb-2 pr-4 font-medium">Net</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-3 pr-4 font-mono text-xs text-gray-500">
                        {p.id.slice(0, 8)}…
                      </td>
                      <td className="py-3 pr-4">
                        <a
                          href={`/dashboard/lab/orders/${p.orderId}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {p.orderId.slice(0, 8)}…
                        </a>
                      </td>
                      <td className="py-3 pr-4">
                        {wallet.currency} {p.grossAmount}
                      </td>
                      <td className="py-3 pr-4">
                        {wallet.currency} {p.platformFee}
                      </td>
                      <td className="py-3 pr-4">
                        {wallet.currency} {p.netAmount}
                      </td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="py-3">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
