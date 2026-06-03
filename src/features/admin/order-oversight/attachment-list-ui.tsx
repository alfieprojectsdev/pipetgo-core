'use client'

import { useState } from 'react'
import { type AttachmentType } from '@prisma/client'
import { viewOrderAttachment } from './view-attachment-action'

type AttachmentItem = {
  id: string
  fileName: string
  attachmentType: AttachmentType
  createdAt: string
}

export function AttachmentListUi({ attachments }: { attachments: AttachmentItem[] }) {
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (attachments.length === 0) return null

  async function handleView(id: string) {
    setErrors((prev) => ({ ...prev, [id]: '' }))
    const win = window.open('', '_blank')
    const result = await viewOrderAttachment(id)
    if ('url' in result) {
      if (win) {
        win.location.href = result.url
      } else {
        window.location.href = result.url
      }
    } else {
      win?.close()
      setErrors((prev) => ({ ...prev, [id]: result.message ?? 'Unable to retrieve file.' }))
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Attachments</h2>
      <ul className="divide-y divide-gray-100">
        {attachments.map((a) => (
          <li key={a.id} className="py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-gray-800 truncate">{a.fileName}</p>
              <p className="text-xs text-gray-500">{a.attachmentType} &middot; {new Date(a.createdAt).toLocaleString()}</p>
              {errors[a.id] && (
                <p className="text-xs text-red-600 mt-1">{errors[a.id]}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleView(a.id)}
              className="shrink-0 text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              View
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
