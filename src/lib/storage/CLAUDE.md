# storage/

Object storage clients. Separate namespace from `src/lib/payments/` — storage is not a payment provider.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `r2.ts` | Cloudflare R2 presigned PUT and GET URL generation; `R2ConfigError`, `R2ValidationError`, `ALLOWED_MIME_TYPES`, `MAX_BYTES` | Implementing any file upload or admin document-view feature; modifying MIME or size limits |
| `README.md` | Design decisions — presigned PUT/GET pattern, key shape, TTL rationale, server-trusted key invariant | Understanding why this client is structured this way |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `__tests__/` | Unit tests — S3Client mocked at SDK boundary | Running or adding storage tests |
