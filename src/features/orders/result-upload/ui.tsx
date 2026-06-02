/**
 * Client component: ResultUploadUi
 *
 * Two-step RESULT upload flow for LAB_ADMIN users — mirrors SpecUploadUi but
 * with PDF-only MIME validation, 50 MB size limit, and a 120s AbortSignal.timeout
 * on the PUT (RESULT files are larger than SPECIFICATION files). (ref: DL-003)
 * Badge/type maps are copied per slice, not cross-imported. (ref: DL-003)
 */
'use client'

import { useActionState, useRef, useEffect, useState } from 'react'
import { requestResultUploadUrl } from './upload-action'
import { confirmResultUpload } from './confirm-action'
import { viewResultAttachment } from './view-attachment-action'

type UploadResult = { presignedUrl: string; r2Key: string; attachmentId: string }
type UploadState  = { message?: string } | UploadResult | null
type ConfirmState = { message?: string } | null

const RESULT_MIME_TYPES = ['application/pdf']
const MAX_RESULT_BYTES  = 50 * 1024 * 1024

type AttachmentDTO = { id: string; fileName: string; createdAt: string }

export function SpecAttachmentListUi({ attachments }: { attachments: AttachmentDTO[] }) {
  const [viewError, setViewError] = useState<string | null>(null)

  async function handleView(attachmentId: string) {
    setViewError(null)
    const win = window.open('', '_blank')
    try {
      const res = await viewResultAttachment(attachmentId)
      if ('url' in res) {
        if (win) win.location.href = res.url
        else window.location.href = res.url
      } else {
        win?.close()
        setViewError(res.message ?? 'Unable to retrieve file.')
      }
    } catch {
      win?.close()
      setViewError('Unable to retrieve file.')
    }
  }

  if (attachments.length === 0) return <p className="text-sm text-gray-500">No specification documents uploaded.</p>

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-gray-100 rounded-lg border bg-white">
        {attachments.map((a) => (
          <li key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-gray-800">{a.fileName}</span>
            <button
              type="button"
              onClick={() => void handleView(a.id)}
              className="text-blue-600 hover:underline text-xs"
            >
              View
            </button>
          </li>
        ))}
      </ul>
      {viewError && <p className="text-sm text-red-600">{viewError}</p>}
    </div>
  )
}

export function ResultUploadUi({ orderId, attachments }: { orderId: string; attachments: AttachmentDTO[] }) {
  const fileRef = useRef<HTMLInputElement>(null)

  const [uploadState, uploadAction, uploadPending] = useActionState(
    requestResultUploadUrl,
    null as UploadState,
  )
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmResultUpload,
    null as ConfirmState,
  )

  const [putError,  setPutError]  = useState<string | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)

  useEffect(() => {
    if (!uploadState || !('presignedUrl' in uploadState)) return
    const result = uploadState as UploadResult
    const file = fileRef.current?.files?.[0]
    if (!file) return

    void (async () => {
      try {
        const putRes = await fetch(result.presignedUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
          signal: AbortSignal.timeout(120_000),
        })
        if (!putRes.ok) {
          setPutError(`Upload failed (HTTP ${putRes.status}). Please try again.`)
          return
        }
        setPutError(null)
        const confirmFd = new FormData()
        confirmFd.set('attachmentId', result.attachmentId)
        confirmFd.set('orderId', orderId)
        void confirmAction(confirmFd)
      } catch (err) {
        setPutError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
      }
    })()
  }, [uploadState, confirmAction, orderId])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPutError(null)
    const fileInput = fileRef.current
    if (!fileInput?.files?.[0]) return
    const file = fileInput.files[0]
    if (!RESULT_MIME_TYPES.includes(file.type)) {
      setPutError('Unsupported file type. Result documents must be PDF.')
      return
    }
    if (file.size > MAX_RESULT_BYTES) {
      setPutError('File exceeds 50 MB limit.')
      return
    }
    const fd = new FormData()
    fd.set('orderId',  orderId)
    fd.set('fileName', file.name)
    fd.set('mimeType', file.type)
    fd.set('fileSize', String(file.size))
    void uploadAction(fd)
  }

  async function handleView(attachmentId: string) {
    setViewError(null)
    const win = window.open('', '_blank')
    try {
      const res = await viewResultAttachment(attachmentId)
      if ('url' in res) {
        if (win) win.location.href = res.url
        else window.location.href = res.url
      } else {
        win?.close()
        setViewError(res.message ?? 'Unable to retrieve file.')
      }
    } catch {
      win?.close()
      setViewError('Unable to retrieve file.')
    }
  }

  return (
    <div className="space-y-4">
      {attachments.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border bg-white">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-gray-800">{a.fileName}</span>
              <button type="button" onClick={() => void handleView(a.id)} className="text-blue-600 hover:underline text-xs">
                View
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewError && <p className="text-sm text-red-600">{viewError}</p>}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Result document (PDF — max 50 MB)
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            required
            className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
          />
        </div>
        {uploadState && 'message' in uploadState && uploadState.message && (
          <p className="text-sm text-red-600">{uploadState.message}</p>
        )}
        {confirmState && 'message' in confirmState && confirmState.message && (
          <p className="text-sm text-red-600">{confirmState.message}</p>
        )}
        {putError && <p className="text-sm text-red-600">{putError}</p>}
        <button
          type="submit"
          disabled={uploadPending || confirmPending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {uploadPending || confirmPending ? 'Uploading…' : 'Upload Result'}
        </button>
      </form>
    </div>
  )
}
