import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [preact()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022', outDir: 'dist' },
  preview: { port: 4173, strictPort: true },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
} as never);
