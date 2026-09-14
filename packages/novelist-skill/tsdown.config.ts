import { defineConfig } from 'tsdown'

/**
 * Build the Web UI (browser) half.
 *
 * The shell does not load plain ESM for client plugins: `@deepseek-ai/dsh-client-modules`
 * serves `/plugins/<id>/client.js` and the browser's module table expects the file to
 * register a CommonJS-style factory, exactly like every shipped `dsh-client-ui-*`
 * bundle:
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * ```
 *
 * `banner`/`footer` therefore wrap the CJS output in that registration call. Every
 * `@deepseek-ai/*` package and React stay unbundled: the shell owns those module
 * instances, and shipping a second copy would break the plugin's identity in the
 * tree (and React hooks across copies).
 */
/**
 * The registration id the shell matches this bundle against.
 *
 * `dsh-client-modules` validates a bundle's registered id against the loader
 * entry it serves (its own `stripClientSuffix(registration.id)` lookup), and
 * that entry is the *package* the client half belongs to. The development
 * package and the shipped package have different names — the distribution merges
 * the plugin into the bundle package — so the id is injected at build time
 * instead of baked in, and the packaging step rebuilds with the shipped name.
 */
const CLIENT_ID = process.env.DSH_CLIENT_ID ?? '@ai-novelist/novelist-skill'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  // The shell serves this file as `/plugins/<id>/client.js`, so the extension is
  // part of the contract rather than a preference. Under `type: module`, an
  // explicit `outExtensions` is what keeps rolldown from emitting `.cjs`.
  outExtensions: () => ({ js: '.js' }),
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  },
  banner: `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`,
  footer: `
    return module.exports;
  }
});
`,
})
