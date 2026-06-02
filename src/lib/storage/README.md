# src/lib/storage

## Overview

Cloudflare R2 object storage client for document uploads. Uses presigned PUT URLs so
the browser uploads directly to R2, bypassing the Next.js Server Action FormData limit
(4.5 MB on Vercel). Supports `labs/` objects (KYC/accreditation, up to 20 MB) and
`orders/` objects (SPECIFICATION up to 20 MB, RESULT up to 50 MB).

## Architecture

`r2.ts` exposes `generatePresignedPutUrl(key, contentType, contentLength, options?)` where
`options` carries `allowedPrefix` (`'labs/'` | `'orders/'`) and `maxBytes`. The Server Action
calls this function, returns the URL to the client, and the client PUTs the file directly to R2.
The signed URL binds `Content-Type` so R2 rejects uploads whose actual header does not match
the signed value.

`r2.ts` also exposes `generatePresignedGetUrl(key, options?)` where `options` carries
`allowedPrefix`. A Server Action calls this to mint a 300s-TTL signed URL for a specific R2
object. The key is always derived server-side from a stored `r2Key` column — never from client
input.

R2 credentials never leave the server. The client receives only the short-lived presigned URL.

## Design Decisions

**Presigned PUT URL vs Server Action streaming (DL-005):** The Vercel runtime caps Server Action FormData at 4.5 MB. KYC documents (BIR 2303, DTI/SEC registration) can reach 20 MB. Presigned PUT bypasses the cap and removes Next.js from the data path.

**TTL of 300 s (DL-005):** Bounds the window during which a leaked URL is exploitable while accommodating slow mobile uploads.

**Server-generated keys — clients never supply the key (DL-006, DL-008):** Key shape is
`labs/{labId}/{cuid}.{ext}` for lab documents and `orders/{orderId}/{cuid}.{ext}` for order
attachments — both derived from the session-resolved entity id. A client-supplied key would
allow a malicious actor to PUT into another entity's prefix.

**Prefix guard enforced in `r2.ts` (DL-004):** Each caller passes an explicit `allowedPrefix`
(`'labs/'` or `'orders/'`) from the `ALLOWED_PREFIXES` union. The function throws
`R2ValidationError` if the key does not start with that exact prefix. No wildcards or
arrays accepted — weakening this to accept any prefix is a security regression.

**Per-caller size limit via `maxBytes` (DL-005):** Callers pass `MAX_BYTES` (20 MB) or
`MAX_RESULT_BYTES` (50 MB) from `constants.ts`. Both the action-level check and `r2.ts`
`validateSize` must use the same `maxBytes` value — a mismatch causes `r2.ts` to reject
a RESULT PUT that the action already approved.

**`src/lib/storage/` is separate from `src/lib/payments/`:** R2 is object storage.
Placing it under `payments/` would contaminate the payments namespace with future storage
clients (thumbnails, reports).

**`generatePresignedGetUrl` mints on demand per authorized access:** The key is loaded from
a stored `r2Key` column — never from client input. TTL is 300 s; the URL is not embedded in
any RSC payload so each access requires a fresh role+ownership re-check in the caller's
Server Action.

## Invariants

- `generatePresignedPutUrl` throws `R2ConfigError` when any required env var is absent. Config
  validation is lazy (inside the function) so tests that mock the SDK remain cheap.
- `allowedPrefix` must be a member of `ALLOWED_PREFIXES = ['labs/', 'orders/']`; key must start
  with that exact prefix. `R2ValidationError` is thrown otherwise.
- `MAX_BYTES` = 20 MB (SPECIFICATION/KYC); `MAX_RESULT_BYTES` = 50 MB (RESULT). Pass the
  correct constant from `constants.ts` through both the action check and `r2.ts`.
- `generatePresignedGetUrl(key, options?)`: same prefix guard via `options.allowedPrefix`; returns
  a 300 s presigned GET URL. The key is always server-trusted — loaded from a stored `r2Key` column.
