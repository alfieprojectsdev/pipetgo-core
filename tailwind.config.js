/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CSS variable tokens — referenced in existing V2 components:
        //   button.tsx: focus-visible:ring-ring
        //   card.tsx:   border (default color via preflight)
        // V2 brand: green-600 primary (diverged from V1 blue #3b82f6)
        border: 'hsl(var(--border))',
        ring: 'hsl(var(--ring))',
      },
    },
  },
  plugins: [],
}
