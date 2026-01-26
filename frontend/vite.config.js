import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 8081,
    open: false,
    host: true,
    proxy: {
      '/agent': {
        target: 'http://localhost:8080',
        ws: true,
        changeOrigin: true
      },
      '/metadata': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 8081,
    open: true,
    host: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});

