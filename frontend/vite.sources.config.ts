import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone build of the sources pane for lab delivery as a ConfigMap:
// flat output (ConfigMap keys cannot contain '/'), one JS, at most one CSS.
// The entry is sources.html; scripts/rename-sources-index.cjs renames it to
// index.html after the build.
export default defineConfig({
  plugins: [react()],
  base: '/sources/',
  publicDir: false,
  build: {
    outDir: 'dist-sources',
    emptyOutDir: true,
    assetsDir: '',
    cssCodeSplit: false,
    rollupOptions: {
      input: 'sources.html',
      output: {
        entryFileNames: 'sources.js',
        chunkFileNames: 'sources.js',
        assetFileNames: 'sources[extname]',
        inlineDynamicImports: true,
      },
    },
  },
})
