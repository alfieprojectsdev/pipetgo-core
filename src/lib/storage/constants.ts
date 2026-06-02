// MAX_RESULT_BYTES: RESULT attachments (lab-delivered PDFs) carry ITA result-integrity
// liability and may be large data files. The 50 MB ceiling is separate from MAX_BYTES
// (20 MB for SPECIFICATION/KYC uploads) so each caller threads the correct limit
// through both the action-level check and r2.ts validateSize. (ref: DL-005)
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export const MAX_BYTES = 20 * 1024 * 1024
export const MAX_RESULT_BYTES = 50 * 1024 * 1024
