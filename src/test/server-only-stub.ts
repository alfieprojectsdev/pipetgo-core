// Test-only stub for the `server-only` package. The real module throws when
// imported outside a React Server Component context; under vitest (node env)
// there is no such context, so any module that does `import 'server-only'`
// (e.g. src/lib/storage/r2.ts) would fail to load. vitest.config.ts aliases
// `server-only` to this empty module so those modules are unit-testable.
export {}
