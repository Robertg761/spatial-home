import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // The 3D view's chunk is mostly three.js, which can't be split further. It loads only when the
    // 3D view is first opened.
    chunkSizeWarningLimit: 700,
  },
});
