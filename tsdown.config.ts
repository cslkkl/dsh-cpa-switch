import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-cpa-switch'

/**
 * Modules the host loader provides, kept out of the browser bundle.
 *
 * This list is a guardrail, not documentation: anything imported by value and
 * *not* named here gets **inlined**, and inlining a React runtime is fatal
 * rather than merely fat. A sibling DSH plugin hit exactly that — a missing
 * `react-dom` entry inlined the runtime, grew the bundle ~80 KB → 1 MB, and the
 * browser threw `process is not defined` on load, because that module scope
 * reads `process.env.NODE_ENV`. The plugin failed to activate.
 *
 * That precedent is why the list is exhaustive rather than minimal.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale/client',
] as const

/** Host-provided modules the Node half imports by value rather than bundling. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/schemastery',
] as const

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
