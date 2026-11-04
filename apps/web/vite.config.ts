import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Yerel geliştirmede API'ye proxy. Bulutta web statik varlık olarak CDN/obje deposundan, API ayrı servisten sunulur.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // SP_API_PROXY: aynı web'i başka bir API kopyasına bağlamak için (ör. OIDC modunda ikinci API).
  server: { proxy: { '/api': process.env.SP_API_PROXY ?? 'http://localhost:4100' } },
  build: { target: 'es2022', sourcemap: true },
});
