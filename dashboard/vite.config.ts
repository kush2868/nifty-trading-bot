import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/trades': 'http://localhost:3000',
      '/risk': 'http://localhost:3000',
      '/market': 'http://localhost:3000',
      '/control': 'http://localhost:3000',
      '/kite': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
