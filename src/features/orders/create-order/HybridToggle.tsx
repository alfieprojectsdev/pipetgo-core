'use client'

import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'

type HybridToggleProps = {
  pricePerUnit: string | null
  onToggle: (val: boolean) => void
}

export function HybridToggle({ pricePerUnit, onToggle }: HybridToggleProps) {
  const [requestCustomQuote, setRequestCustomQuote] = useState(false)

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.checked
    setRequestCustomQuote(next)
    onToggle(next)
  }

  return (
    <div className="space-y-3">
      {/* Hidden input carries the boolean reliably in native FormData regardless of checkbox state */}
      <input type="hidden" name="requestCustomQuote" value={String(requestCustomQuote)} />
      <div className="flex items-start space-x-2">
        <input
          type="checkbox"
          id="requestCustomQuote"
          checked={requestCustomQuote}
          onChange={handleChange}
          className="mt-1"
        />
        <label htmlFor="requestCustomQuote" className="text-sm cursor-pointer">
          Request custom quote instead of reference price (
          {pricePerUnit ? `₱${pricePerUnit}` : 'N/A'})
        </label>
      </div>

      {requestCustomQuote ? (
        <Alert>
          <AlertDescription>
            <span className="text-green-600 font-medium">ℹ️ Custom quote</span>
            <p className="text-sm mt-1">You&apos;ll receive a custom quote from the lab.</p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertDescription>
            <span className="text-green-600 font-medium">✓ Instant booking</span>
            <p className="text-sm mt-1">
              You&apos;ll book at the reference price:{' '}
              {pricePerUnit ? `₱${pricePerUnit}` : 'N/A'}
            </p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
