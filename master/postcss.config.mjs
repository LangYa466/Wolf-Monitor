// PostCSS config must be .mjs (or .js) — Next.js 15 + tailwindcss 3 does not
// load postcss.config.ts via the build pipeline, so the @tailwind directives
// were shipped raw to the browser and every utility class lost its style.
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
