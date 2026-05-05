# features/

Vertical slice features. Each subdirectory is a self-contained slice with its own page, action, and UI components.

## Subdirectories

| Directory  | What                                       | When to read                                      |
| ---------- | ------------------------------------------ | ------------------------------------------------- |
| `orders/`  | Order creation and management slices       | Implementing any order flow                       |
| `auth/`    | Authentication UI and flows                | Modifying sign-in, sign-out, or session handling  |
| `labs/`    | Lab profile and listing slices             | Implementing lab-facing or marketplace features   |
| `payments/`| Payment flow slices; webhook slice includes integration tests in `payments/webhooks/__tests__/` | Implementing checkout or payment status pages, or running payment capture integration tests |
| `services/`| Lab service listing and detail slices      | Implementing service browsing or search           |
| `clients/` | Client-facing feature slices               | Implementing client dashboard or order views      |
