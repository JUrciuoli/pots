# Jane's pots

A small phone app for tracking pottery through the studio: works in progress by stage, a gallery of finished pieces, and a list of ideas and commissions.

**Live app:** https://jurciuoli.github.io/pots/ (add it to your iPhone home screen: Share → Add to Home Screen)

## How it's put together

- React + Vite, published to GitHub Pages automatically on every push to `main` (`.github/workflows/deploy.yml`).
- Data lives in Supabase (free plan). Connection details are in `src/config.js`, and can also be changed in the app under Settings → Database.
- `supabase/setup.sql` creates the tables, turns on sign-in-only access, and sets up photo storage.
- Installable as a home-screen app (`public/manifest.webmanifest`, icons, `public/sw.js`).

## Try it without touching real data

Open the app with `?demo` at the end of the address. Nothing is saved.

## Run locally

```
npm install
npm run dev
```
