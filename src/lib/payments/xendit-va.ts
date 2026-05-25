/**
 * Xendit Fixed Virtual Account API client — infrastructure layer.
 *
 * Provides a typed interface to the Xendit Fixed VA API
 * (POST /fixed-virtual-accounts). `is_closed: true` enforces single-payment
 * binding — prevents double-credit on the same virtual account number.
 *
 * Must not import from @/features/ or @/domain/; this is infrastructure.
 */

/** Parameters sent to the Xendit Fixed VA API to create a virtual account. */
export type XenditVaParams = {
  externalId: string
  bankCode: string
  name: string
  expectedAmount: number
  expirationDate: Date
}

/**
 * Normalised result from a successful Xendit virtual account creation.
 *
 * vaId          — Xendit's VA ID, stored in VirtualAccount.externalId (DB column).
 * accountNumber — The virtual account number displayed to the payer.
 * bankCode      — Bank code confirming which bank the VA belongs to.
 * externalId    — Echoed external_id from the request, for cross-reference.
 * rawResponse   — Full Xendit response body, stored in VirtualAccount.metadata for audit.
 */
export type XenditVaResult = {
  vaId: string
  accountNumber: string
  bankCode: string
  externalId: string
  rawResponse: Record<string, unknown>
}

/**
 * Thrown when the Xendit Fixed VA API returns a non-2xx response, or when
 * XENDIT_SECRET_KEY is absent. Carries the HTTP status code and raw response
 * body for caller inspection.
 */
export class XenditVaError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Xendit VA API error: ${status}`)
    this.name = 'XenditVaError'
  }
}

/**
 * Creates a Xendit Fixed Virtual Account and returns the account details.
 *
 * `is_closed: true` is hardcoded — this binds the VA to a single expected
 * payment amount and prevents any other amount from being credited, which
 * eliminates the double-credit risk on repeat deposits.
 *
 * Must not import from @/features/ or @/domain/; this is infrastructure.
 */
export async function createXenditVa(
  params: XenditVaParams,
): Promise<XenditVaResult> {
  const secretKey = process.env.XENDIT_SECRET_KEY
  if (!secretKey) {
    throw new XenditVaError(500, null, 'XENDIT_SECRET_KEY is not set')
  }

  const credentials = Buffer.from(`${secretKey}:`).toString('base64')

  const response = await fetch('https://api.xendit.co/fixed-virtual-accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({
      external_id: params.externalId,
      bank_code: params.bankCode,
      name: params.name,
      expected_amount: params.expectedAmount,
      is_closed: true,
      expiration_date: params.expirationDate.toISOString(),
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new XenditVaError(response.status, errorBody)
  }

  const raw = (await response.json()) as Record<string, unknown>

  return {
    vaId: raw['id'] as string,
    accountNumber: raw['account_number'] as string,
    bankCode: raw['bank_code'] as string,
    externalId: raw['external_id'] as string,
    rawResponse: raw,
  }
}
