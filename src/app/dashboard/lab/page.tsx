// App router mount point for the lab dashboard RSC.
// Implementation lives in src/features/labs/dashboard/page.tsx (DL-007).
// This file is a re-export only; all logic belongs to the feature slice.
// Keeping logic in the feature slice preserves VSA boundary isolation
// and allows the slice to be tested independently of the app router.
export { default } from '@/features/labs/dashboard/page'
