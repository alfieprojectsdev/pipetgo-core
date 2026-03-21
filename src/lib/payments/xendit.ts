/**
 * Xendit payment gateway integration — infrastructure layer.
 *
 * Provides a typed interface to the Xendit Invoice API (POST /v2/invoices).
 * Currency is hardcoded to PHP; PipetGo operates in the Philippines only (ref: DL-008).
 * Swap to a different provider by adding a parallel file (e.g. paymongo.ts) and
 * updating the import in action.ts — no schema migration required (ref: DL-001).
 *
 * Must not import from @/features/ or @/domain/; this is infrastructure.
 */

/** Parameters sent to the Xendit Invoice API to create a hosted payment page. */
export type XenditInvoiceParams = {
  externalId: string
  amount: number
  payerEmail: string
  description: string
  successRedirectUrl: string
}

/**
 * Normalised result from a successful Xendit invoice creation.
 *
 * invoiceId   — Xendit's invoice ID, stored in Transaction.externalId (DB column).
 * invoiceUrl  — Hosted checkout URL; user is redirected here.
 * rawResponse — Full Xendit response body, stored in Transaction.metadata for audit.
 */
export type XenditInvoiceResult = {
  invoiceId: string
  invoiceUrl: string
  rawResponse: Record<string, unknown>
}

/**
 * Thrown when the Xendit API returns a non-2xx response.
 * Carries the HTTP status code and raw response body for caller inspection.
 */
export class XenditApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'XenditApiError'
  }
}

/**
 * Creates a Xendit-hosted invoice and returns the checkout URL.
 *
 * Sequence (ref: DL-002):
 *   1. Reads XENDIT_SECRET_KEY from env — throws XenditApiError(500) if absent.
 *   2. POST /v2/invoices with Basic Auth (secretKey as username, empty password).
 *   3. Returns invoiceId (stored in Transaction.externalId), invoiceUrl (redirect
 *      target), and rawResponse (stored in Transaction.metadata).
 *
 * Call ordering in the checkout action: this function is called BEFORE the Prisma
 * Transaction.create write. If the DB write fails, the orphaned Xendit invoice is
 * recoverable via the idempotency guard on retry. The inverse — DB write first,
 * Xendit call second — leaves the user with no invoice URL on Xendit failure
 * (ref: DL-002).
 *
 * Currency is always PHP (ref: DL-008).
 */
export async function createXenditInvoice(
  params: XenditInvoiceParams,
): Promise<XenditInvoiceResult> {
  const secretKey = process.env.XENDIT_SECRET_KEY
  if (!secretKey) {
    throw new XenditApiError('XENDIT_SECRET_KEY is not set', 500, null)
  }

  const credentials = Buffer.from(`${secretKey}:`).toString('base64')

  const response = await fetch('https://api.xendit.co/v2/invoices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({
      external_id: params.externalId,
      amount: params.amount,
      payer_email: params.payerEmail,
      description: params.description,
      success_redirect_url: params.successRedirectUrl,
      currency: 'PHP',
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new XenditApiError(
      `Xendit API error: ${response.status}`,
      response.status,
      errorBody,
    )
  }

  const raw = (await response.json()) as Record<string, unknown>

  return {
    invoiceId: raw['id'] as string,
    invoiceUrl: raw['invoice_url'] as string,
    rawResponse: raw,
  }
}
