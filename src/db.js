import { createClient } from '@supabase/supabase-js';
import {
  DEFAULT_SUPABASE_URL,
  DEFAULT_SUPABASE_KEY,
  OLD_SUPABASE_URL,
  OLD_SUPABASE_KEY,
  PHOTO_BUCKET,
} from './config.js';

const LS_CFG = 'pots.db';
const EXTRA_COLS = ['glaze', 'clay', 'stage_dates', 'due_date'];

export function getConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
    if (c?.url && c?.key) return c;
  } catch {}
  return { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY };
}
export function setConfig(cfg) {
  if (!cfg) localStorage.removeItem(LS_CFG);
  else localStorage.setItem(LS_CFG, JSON.stringify(cfg));
}
export const isUsingOldDatabase = () => getConfig().url === OLD_SUPABASE_URL;

const isDemo = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');

/* ---------------- real backend ---------------- */
function makeRemote() {
  const { url, key } = getConfig();
  const sb = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pots.auth' },
  });
  let extras = null; // whether the extra columns exist

  async function detectExtras() {
    if (extras !== null) return extras;
    const { error } = await sb.from('pieces').select('glaze,clay,stage_dates,due_date').limit(1);
    extras = !error;
    return extras;
  }
  const clean = (patch) => {
    if (extras) return patch;
    const p = { ...patch };
    EXTRA_COLS.forEach((c) => delete p[c]);
    return p;
  };

  return {
    demo: false,
    sb,
    async session() {
      const { data } = await sb.auth.getSession();
      return data.session;
    },
    onAuth(cb) {
      const { data } = sb.auth.onAuthStateChange((_e, s) => cb(s));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signOut() {
      await sb.auth.signOut();
    },
    hasExtras: () => extras,
    async loadAll() {
      await detectExtras();
      const [p, ph] = await Promise.all([
        sb.from('pieces').select('*').order('created_at', { ascending: false }),
        sb.from('photos').select('*').order('created_at', { ascending: true }),
      ]);
      if (p.error) throw p.error;
      if (ph.error) throw ph.error;
      return { pieces: p.data, photos: ph.data };
    },
    async createPiece(data) {
      const { data: row, error } = await sb.from('pieces').insert(clean(data)).select().single();
      if (error) throw error;
      return row;
    },
    async updatePiece(id, patch) {
      const { data: row, error } = await sb.from('pieces').update(clean(patch)).eq('id', id).select().single();
      if (error) throw error;
      return row;
    },
    async deletePiece(id) {
      await sb.from('photos').delete().eq('piece_id', id);
      const { error } = await sb.from('pieces').delete().eq('id', id);
      if (error) throw error;
    },
    async uploadBlob(blob) {
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
      const { error } = await sb.storage.from(PHOTO_BUCKET).upload(name, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      return sb.storage.from(PHOTO_BUCKET).getPublicUrl(name).data.publicUrl;
    },
    async addPhoto(pieceId, blob, isPrimary) {
      const url = await this.uploadBlob(blob);
      if (isPrimary) await sb.from('photos').update({ is_primary: false }).eq('piece_id', pieceId);
      const { data: row, error } = await sb
        .from('photos')
        .insert({ piece_id: pieceId, url, is_primary: !!isPrimary })
        .select()
        .single();
      if (error) throw error;
      return row;
    },
    async setPrimaryPhoto(pieceId, photoId) {
      await sb.from('photos').update({ is_primary: false }).eq('piece_id', pieceId);
      const { error } = await sb.from('photos').update({ is_primary: true }).eq('id', photoId);
      if (error) throw error;
    },
    async deletePhoto(photo) {
      const { error } = await sb.from('photos').delete().eq('id', photo.id);
      if (error) throw error;
      const m = photo.url.match(new RegExp(`/${PHOTO_BUCKET}/(.+)$`));
      if (m && photo.url.startsWith(getConfig().url)) {
        await sb.storage.from(PHOTO_BUCKET).remove([m[1]]);
      }
    },

    /* Copies everything from the Bolt-era database into this one. */
    async importFromOld(onProgress = () => {}) {
      const h = { apikey: OLD_SUPABASE_KEY, Authorization: `Bearer ${OLD_SUPABASE_KEY}` };
      const get = (t) => fetch(`${OLD_SUPABASE_URL}/rest/v1/${t}?select=*`, { headers: h }).then((r) => r.json());
      const [pieces, photos] = await Promise.all([get('pieces'), get('photos')]);
      await detectExtras();
      onProgress(`Copying ${pieces.length} pieces…`);
      const rows = pieces.map(({ user_id, ...p }) => clean({ ...p, stage_dates: p.stage_dates ?? {} }));
      const { error } = await sb.from('pieces').upsert(rows);
      if (error) throw error;
      let n = 0;
      for (const ph of photos) {
        n++;
        onProgress(`Copying photo ${n} of ${photos.length}…`);
        let url = ph.url;
        if (url.startsWith(OLD_SUPABASE_URL)) {
          try {
            const blob = await fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject()));
            url = await this.uploadBlob(blob);
          } catch {
            /* keep the old link if the copy fails */
          }
        }
        const { error: e2 } = await sb.from('photos').upsert({ ...ph, url });
        if (e2) throw e2;
      }
      return { pieces: pieces.length, photos: photos.length };
    },
  };
}

/* ---------------- demo backend (in memory, for testing: add ?demo to the URL) ---------------- */
function makeDemo() {
  let pieces = [];
  let photos = [];
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
  const add = (title, stage, extra = {}) =>
    pieces.push({
      id: crypto.randomUUID(),
      title,
      description: null,
      stage,
      is_graveyard: false,
      is_commission: false,
      priority: null,
      created_at: iso(30),
      completed_at: stage === 'completed' ? iso(5) : null,
      display_order: pieces.length,
      glaze: null,
      clay: null,
      due_date: null,
      stage_dates: { [stage]: iso(extra.days ?? 3) },
      ...extra,
    });
  add('Flaps vase', 'bisque_firing', { days: 11, clay: 'Speckled buff' });
  add('Charms', 'glaze_firing', { days: 0 });
  add('Boot matches', 'glaze_firing', { days: 0 });
  add('Gashed vase', 'glaze_firing', { days: 11, glaze: 'Celadon over tenmoku' });
  add('Olive oil', 'completed');
  add('Shallow bowl', 'completed', { description: 'For Benton' });
  add('Wavy bowls', 'completed', { description: 'X8' });
  add('Amanda fruit bowl', 'idea', { description: 'ASAP', due_date: '2026-12-01' });
  add('Colander', 'idea', { description: 'Audrey and Benton', is_commission: true });
  add('Porcelain lamp', 'idea');
  add('Ski shot glasses', 'bisque_firing', { is_graveyard: true });
  const sw = (c) =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${c}"/><ellipse cx="200" cy="230" rx="90" ry="120" fill="#fff8"/></svg>`
    );
  photos.push({ id: 'p1', piece_id: pieces[4].id, url: sw('#b9a48f'), is_primary: true, created_at: iso(5) });
  photos.push({ id: 'p2', piece_id: pieces[5].id, url: sw('#8fa3a8'), is_primary: true, created_at: iso(5) });
  const wait = () => new Promise((r) => setTimeout(r, 120));
  return {
    demo: true,
    async session() {
      return { user: { email: 'demo@example.com' } };
    },
    onAuth() {
      return () => {};
    },
    async signIn() {},
    async signOut() {},
    hasExtras: () => true,
    async loadAll() {
      await wait();
      return { pieces: structuredClone(pieces), photos: structuredClone(photos) };
    },
    async createPiece(d) {
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), is_graveyard: false, ...d };
      pieces.unshift(row);
      return structuredClone(row);
    },
    async updatePiece(id, patch) {
      const p = pieces.find((x) => x.id === id);
      Object.assign(p, patch);
      return structuredClone(p);
    },
    async deletePiece(id) {
      pieces = pieces.filter((p) => p.id !== id);
    },
    async addPhoto(pieceId, blob, isPrimary) {
      if (isPrimary) photos.forEach((p) => p.piece_id === pieceId && (p.is_primary = false));
      const row = { id: crypto.randomUUID(), piece_id: pieceId, url: URL.createObjectURL(blob), is_primary: !!isPrimary, created_at: new Date().toISOString() };
      photos.push(row);
      return row;
    },
    async setPrimaryPhoto(pieceId, photoId) {
      photos.forEach((p) => p.piece_id === pieceId && (p.is_primary = p.id === photoId));
    },
    async deletePhoto(photo) {
      photos = photos.filter((p) => p.id !== photo.id);
    },
    async importFromOld() {
      return { pieces: 0, photos: 0 };
    },
  };
}

export const api = isDemo ? makeDemo() : makeRemote();

/* Shrink phone photos before upload (max 1600px, JPEG). */
export async function resizeImage(file, max = 1600) {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.85));
}
