import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Separate builds: the usual Electron entry is never imported by the Node host or browser.
export default defineConfig(({ isSsrBuild }) => ({
  root: resolve(__dirname, isSsrBuild ? '.' : 'src/headless/web'),
  publicDir: false,
  plugins: isSsrBuild ? [{ name: 'standalone-node-host', generateBundle(_options, bundle) {
    for (const part of Object.values(bundle)) {
      if (part.type === 'chunk' && [...part.imports, ...part.dynamicImports].some(id => !isBuiltin(id))) {
        this.error('The headless runtime must depend only on Node built-ins')
      }
    }
  } }] : [react()],
  build: {
    outDir: resolve(__dirname, isSsrBuild ? 'out/headless' : 'out/headless/web'),
    emptyOutDir: true,
    target: isSsrBuild ? 'node22' : 'es2020',
    rollupOptions: isSsrBuild ? { output: { format: 'es', inlineDynamicImports: true, entryFileNames: 'server.mjs' } } : {}
  }
}))
