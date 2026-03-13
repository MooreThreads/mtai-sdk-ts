import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

declare const process: {
  cwd(): string
}

const localMtaiEntry = `${process.cwd()}/../../core/src/index.ts`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      mtai: localMtaiEntry,
    },
  },
})
