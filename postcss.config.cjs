// .cjs extension required: package.json has "type": "module" but Next.js loads
// postcss config via CJS require() internally — ESM .js would fail to load.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
