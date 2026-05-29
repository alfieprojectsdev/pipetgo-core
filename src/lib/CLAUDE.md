# lib/

Shared server-side utilities and external-service clients. Not slice-specific; importable by any feature.

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `auth.ts` | NextAuth session helpers, role extraction | Modifying authentication or session handling |
| `prisma.ts` | Prisma client singleton | Debugging connection issues; understanding client lifecycle |
| `utils.ts` | General utility functions | Looking for shared helpers before writing new ones |

## Subdirectories

| Directory | What | When to read |
| --------- | ---- | ------------ |
| `payments/` | Xendit invoice and virtual-account clients; webhook auth | Implementing or modifying any Xendit integration |
| `storage/` | Cloudflare R2 presigned PUT URL client for file uploads | Implementing any file upload feature; modifying MIME or size limits |
