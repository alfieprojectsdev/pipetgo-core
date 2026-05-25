/**
 * PESONet domain constants.
 *
 * PESONET_MIN_AMOUNT enforces the PHP 50,000 floor at domain level;
 * both UI and server action validate against this constant.
 * isPesonetBankCode enforces the server-side bank allowlist.
 */

export const PESONET_MIN_AMOUNT = 50_000

export const PESONET_BANK_CODES = [
  'BPI',
  'BDO',
  'RCBC',
  'LANDBANK',
  'UNIONBANK',
] as const

export type PesonetBankCode = (typeof PESONET_BANK_CODES)[number]

/**
 * Returns true when code is one of the Xendit PESONet-eligible bank codes.
 * Used server-side in initiateVaCheckout to enforce the bank allowlist.
 */
export function isPesonetBankCode(code: string): code is PesonetBankCode {
  return (PESONET_BANK_CODES as readonly string[]).includes(code)
}

export const PESONET_BANK_LABELS: Record<PesonetBankCode, string> = {
  BPI: 'Bank of the Philippine Islands',
  BDO: 'Banco de Oro',
  RCBC: 'Rizal Commercial Banking Corporation',
  LANDBANK: 'Land Bank of the Philippines',
  UNIONBANK: 'UnionBank of the Philippines',
}
