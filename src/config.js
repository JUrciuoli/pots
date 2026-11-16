// Where the app keeps its data.
// These two values are safe to publish: the "anon" key only allows what the
// database's security rules allow. Once you sign in, your rules decide access.
// You can also change them inside the app (Settings → Database) without editing code.
export const DEFAULT_SUPABASE_URL = 'https://yzlffgbxlirxuqyzdedo.supabase.co';
export const DEFAULT_SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6bGZmZ2J4bGlyeHVxeXpkZWRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY4ODcwMDYsImV4cCI6MjA4MjQ2MzAwNn0.dSk6jk7rZdyHGgwmy8eLTPTq6f1VC-rT6yTaiCAUCcM';

// The database the Bolt version used. The importer copies from here.
export const OLD_SUPABASE_URL = 'https://yzlffgbxlirxuqyzdedo.supabase.co';
export const OLD_SUPABASE_KEY = DEFAULT_SUPABASE_KEY;

export const PHOTO_BUCKET = 'piece-photos';

export const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'leather_hard', label: 'Leather hard' },
  { key: 'bone_dry', label: 'Bone dry' },
  { key: 'bisque_firing', label: 'Bisque firing' },
  { key: 'glaze_firing', label: 'Glaze firing' },
  { key: 'completed', label: 'Completed' },
];
export const WORK_STAGES = STAGES.filter((s) => s.key !== 'completed');
export const stageLabel = (k) =>
  k === 'idea' ? 'Idea' : STAGES.find((s) => s.key === k)?.label ?? k;
export const nextStage = (k) => {
  const i = STAGES.findIndex((s) => s.key === k);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
};
