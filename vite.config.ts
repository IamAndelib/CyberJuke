import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
} as never);
