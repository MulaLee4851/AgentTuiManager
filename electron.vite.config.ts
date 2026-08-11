import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist-electron',
      rollupOptions: {
        external: ['node-pty']
      },
      lib: {
        entry: {
          main: resolve(__dirname, 'electron/main.ts'),
          'session-host': resolve(__dirname, 'electron/session-host.ts'),
          'claude-permission-hook': resolve(__dirname, 'electron/claude-permission-hook.ts')
        },
        formats: ['cjs'],
        fileName: (_format, entryName) => `${entryName}.js`
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist-electron',
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts'),
        formats: ['cjs'],
        fileName: () => 'preload.js'
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist-electron/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react()]
  }
})
