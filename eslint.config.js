import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
// Boundary rule scoped to src/domain/** files only. Feature slices may import
// from domain; the inverse is forbidden. Pattern uses @/features/* because the
// tsconfig @/ alias maps to src/; relative path patterns do not match actual
// import paths in the codebase. (ref: DL-012)
const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/domain/**/*.ts", "src/domain/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/features/*"],
              message: "Domain kernel must not import from feature slices.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
