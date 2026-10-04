import { readFile } from 'node:fs/promises'
import { basename, resolve as resolvePath, dirname } from 'node:path'
import { transform } from 'lightningcss'
import type { Plugin, UserConfig } from 'tsdown'

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

/**
 * Virtual-id suffix. tsdown's own CSS guard matches ids ending in `.css`, so
 * the virtual id must not — the whole point is to keep module CSS away from a
 * pipeline that would need `@tsdown/css`.
 */
const CSS_VIRTUAL_PREFIX = '\0cpa-switch-css:'
const CSS_VIRTUAL_SUFFIX = '.js'

/**
 * Emit a module that injects one stylesheet at factory execution and exports
 * its class map.
 *
 * The style tag is idempotent by `data-plugin-css`: the browser bundle is
 * loaded once per DSH page, but a hot reload or a second plugin mounting the
 * same module must not stack duplicate rules.
 */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  const tagId = `${id}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/**
 * CSS Modules for the browser bundle, the way DSH's own client packages build
 * them: `x.module.css` resolves to a virtual module that carries the compiled
 * stylesheet as a string and exports the hashed class map, so component code
 * writes `css.card` instead of an inline `CSSProperties` literal.
 *
 * Why the hash: the stylesheet is global once injected, and the host's page
 * has its own class names. Hashed names mean a future rename or a two-line tweak
 * can never collide with a host rule, which is exactly the class of bug that
 * silently restyles a plugin's own cards.
 */
function cssModulesPlugin(id: string): Plugin {
  return {
    name: 'cpa-switch-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const abs =
        importer !== undefined && source.startsWith('.')
          ? resolvePath(dirname(importer), source)
          : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      /**
       * Sort the keys. `cssExports` comes back in a non-deterministic order and
       * the emitted JSON preserves insertion order — so without this, identical
       * source produces a different `lib/client.js` on every build, and "did the
       * artifact change?" stops being answerable.
       */
      const classMap: Record<string, string> = {}
      for (const local of Object.keys(cssExports ?? {}).sort()) {
        classMap[local] = (cssExports as Record<string, { name: string }>)[local]!.name
      }
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  } as Plugin
}

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
    target: 'es2024',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    plugins: [cssModulesPlugin(PLUGIN_ID)],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
