# src/lib/storage

## Overview

Cloudflare R2 object storage client for KYC document uploads. Uses presigned PUT URLs so the browser uploads directly to R2, bypassing the Next.js Server Action FormData limit (4.5 MB on Vercel). KYC documents target up to 20 MB.

## Architecture

`r2.ts` exposes `generatePresignedPutUrl(key, contentType, contentLength)`. The Server Action calls this function, returns the URL to the client, and the client PUTs the file directly to R2. The signed URL binds `Content-Type` so R2 rejects uploads whose actual header does not match the signed value — a second validation layer after the server-side allowlist check.

`r2.ts` also exposes `generatePresignedGetUrl(key)`. A Server Action calls this on admin click to mint a 300s-TTL signed URL for a specific R2 object. The key is always derived server-side from the stored `LabDocument.r2Key` — it is never client-supplied. See DL-004 in `src/features/admin/kyc-review/README.md`.

R2 credentials never leave the server. The client receives only the short-lived presigned URL.

## Design Decisions

**Presigned PUT URL vs Server Action streaming (DL-005):** The Vercel runtime caps Server Action FormData at 4.5 MB. KYC documents (BIR 2303, DTI/SEC registration) can reach 20 MB. Presigned PUT bypasses the cap and removes Next.js from the data path.

**TTL of 300 s (DL-005):** Bounds the window during which a leaked URL is exploitable while accommodating slow mobile uploads.

**Server-generated keys — clients never supply the key (DL-006):** Key shape is `labs/{labId}/{cuid}.{ext}`, derived from the session-resolved `labId`. A client-supplied key would allow a malicious `LAB_ADMIN` to PUT into another lab's prefix.

**`labs/` key prefix enforced in `r2.ts` (DL-006):** The function throws `R2ValidationError` if the key does not start with `labs/`. Belt-and-suspenders: the Server Action also constructs the key, but the storage client rejects out-of-prefix keys independently.

**MIME allowlist and size ceiling enforced server-side before signing (DL-008):** The signed URL also binds `Content-Type`. Two layers: the Server Action rejects invalid values before any R2 call; R2 rejects a PUT whose `Content-Type` header does not match the signed value.

**`src/lib/storage/` is separate from `src/lib/payments/` (DL-009):** R2 is object storage. Placing it under `payments/` would misclassify the dependency surface and contaminate the payments namespace with future storage clients (thumbnails, reports).

**`generatePresignedGetUrl` mints on admin click (DL-004):** A Server Action calls this when an admin clicks View on a KYC document. The key is loaded from the stored `LabDocument.r2Key` — never from client input. TTL is 300 s, matching the PUT path; the URL is not embedded in any RSC payload so each access requires a fresh ADMIN role re-check. The `labs/` prefix guard is reused as defense-in-depth.

## Invariants

- `generatePresignedPutUrl` throws `R2ConfigError` when any of `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT` are absent. Config validation is lazy (inside the function, not at import time) so tests that mock the SDK remain cheap.
- Keys must start with `labs/`. `R2ValidationError` is thrown for any other prefix.
- Allowed MIME types: `application/pdf`, `image/jpeg`, `image/png`. Max size: 20 MB (`20 * 1024 * 1024` bytes).
- `generatePresignedGetUrl(key)`: throws `R2ValidationError` unless `key` starts with `labs/`; returns a 300 s presigned GET URL. The key is always server-trusted (looked up from a stored `LabDocument.r2Key`, never from client input). TTL rationale: 300 s bounds the credential exposure window while being sufficient for a single admin click-to-view.
