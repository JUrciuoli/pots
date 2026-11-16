import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' means the built app works from any folder, e.g. jurciuoli.github.io/pots/
export default defineConfig({
  base: './',
  plugins: [react()],
});
