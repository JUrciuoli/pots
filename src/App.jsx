import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, resizeImage, getConfig, setConfig, isUsingOldDatabase } from './db.js';
import { STAGES, WORK_STAGES, stageLabel, nextStage } from './config.js';
import { Icon } from './icons.jsx';

const nowIso = () => new Date().toISOString();
const LS_TAB = 'pots.tab';

function daysSince(iso) {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 864e5));
}
function ago(iso) {
  const d = daysSince(iso);
  if (d === null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days`;
  if (d < 60) return `${Math.round(d / 7)} wks`;
  return `${Math.round(d / 30)} mo`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function stageSince(p) {
  return p.stage_dates?.[p.stage] ?? (p.stage === 'completed' ? p.completed_at : null);
}
function dueInfo(p) {
  if (!p.due_date) return null;
  const days = Math.ceil((new Date(p.due_date + 'T23:59:59') - Date.now()) / 864e5);
  return { days, label: days < 0 ? `${-days}d overdue` : days === 0 ? 'due today' : `due ${fmtDate(p.due_date)}`, urgent: days <= 7 };
}

export default function App() {
  const [pieces, setPieces] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(undefined);
  const [tab, setTab] = useState(() => localStorage.getItem(LS_TAB) || 'works');
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(null); // 'work' | 'idea'
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef();

  const showToast = useCallback((msg, undo) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, undo });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { pieces, photos } = await api.loadAll();
      setPieces(pieces);
      setPhotos(photos);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.session().then(setSession);
    const off = api.onAuth((s) => {
      setSession(s);
      load();
    });
    load();
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  useEffect(() => localStorage.setItem(LS_TAB, tab), [tab]);

  const photoFor = useMemo(() => {
    const m = {};
    for (const ph of photos) {
      if (!m[ph.piece_id] || ph.is_primary) m[ph.piece_id] = ph;
    }
    return m;
  }, [photos]);

  const live = pieces.filter((p) => !p.is_graveyard);

  async function patchPiece(p, patch, { quiet } = {}) {
    const before = pieces.find((x) => x.id === p.id);
    setPieces((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
    try {
      const row = await api.updatePiece(p.id, patch);
      setPieces((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...row } : x)));
    } catch (e) {
      setPieces((ps) => ps.map((x) => (x.id === p.id ? before : x)));
      showToast(`Couldn't save: ${e.message}`);
      throw e;
    }
    if (!quiet) return before;
  }

  function stagePatch(p, stage) {
    return {
      stage,
      stage_dates: { ...(p.stage_dates || {}), [stage]: nowIso() },
      completed_at: stage === 'completed' ? nowIso() : null,
    };
  }

  async function moveStage(p, stage, { toastIt = true } = {}) {
    if (p.stage === stage) return;
    const prev = { stage: p.stage, stage_dates: p.stage_dates, completed_at: p.completed_at };
    await patchPiece(p, stagePatch(p, stage));
    if (toastIt)
      showToast(`${p.title} → ${stageLabel(stage).toLowerCase()}`, () => {
        patchPiece({ ...p, ...prev }, prev);
        setToast(null);
      });
  }

  async function scrap(p) {
    await patchPiece(p, { is_graveyard: true });
    setOpenId(null);
    showToast(`Scrapped ${p.title}`, () => {
      patchPiece(p, { is_graveyard: false });
      setToast(null);
    });
  }

  async function create(data) {
    const minOrder = Math.min(0, ...pieces.filter((p) => p.stage === 'idea').map((p) => p.display_order ?? 0));
    const row = await api.createPiece({
      description: null,
      is_commission: false,
      is_graveyard: false,
      display_order: data.stage === 'idea' ? minOrder - 1 : Math.floor(Date.now() / 1000),
      completed_at: data.stage === 'completed' ? nowIso() : null,
      stage_dates: { [data.stage]: nowIso() },
      ...data,
    });
    setPieces((ps) => [row, ...ps]);
    return row;
  }

  async function addPhoto(p, file) {
    const blob = await resizeImage(file);
    const isPrimary = !photos.some((ph) => ph.piece_id === p.id);
    const row = await api.addPhoto(p.id, blob, isPrimary);
    setPhotos((phs) => [...phs.map((x) => (isPrimary && x.piece_id === p.id ? { ...x, is_primary: false } : x)), row]);
  }
  async function setPrimary(p, ph) {
    setPhotos((phs) => phs.map((x) => (x.piece_id === p.id ? { ...x, is_primary: x.id === ph.id } : x)));
    await api.setPrimaryPhoto(p.id, ph.id);
  }
  async function removePhoto(ph) {
    setPhotos((phs) => phs.filter((x) => x.id !== ph.id));
    await api.deletePhoto(ph);
  }

  const open = pieces.find((p) => p.id === openId);
  const needsSignIn = session === null && !loading && !error && live.length === 0 && !isUsingOldDatabase();

  return (
    <div className="app">
      {needsSignIn ? (
        <SignIn onOpenSettings={() => setSettings(true)} />
      ) : tab === 'works' ? (
        <Works pieces={live} photoFor={photoFor} onOpen={setOpenId} onNext={moveStage} onMove={moveStage} loading={loading} error={error} onRetry={load} onSettings={() => setSettings(true)} />
      ) : tab === 'gallery' ? (
        <Gallery pieces={live.filter((p) => p.stage === 'completed')} photoFor={photoFor} onOpen={setOpenId} onSettings={() => setSettings(true)} />
      ) : (
        <Ideas pieces={live.filter((p) => p.stage === 'idea')} onOpen={setOpenId} onSettings={() => setSettings(true)} />
      )}

      {tab !== 'gallery' && !needsSignIn && (
        <button className="fab" aria-label={tab === 'ideas' ? 'Add idea' : 'Add piece'} onClick={() => setAdding(tab === 'ideas' ? 'idea' : 'work')}>
          <Icon name="plus" />
        </button>
      )}

      <nav className="tabbar" role="tablist">
        {[
          ['works', 'pot', 'Works'],
          ['gallery', 'grid', 'Gallery'],
          ['ideas', 'bulb', 'Ideas'],
        ].map(([k, ic, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <Icon name={ic} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {open && (
        <PieceSheet
          key={open.id}
          piece={open}
          photos={photos.filter((ph) => ph.piece_id === open.id)}
          extras={api.hasExtras() !== false}
          onClose={() => setOpenId(null)}
          onPatch={(patch) => patchPiece(open, patch)}
          onStage={(s) => moveStage(open, s, { toastIt: false })}
          onStart={async () => {
            await moveStage(open, 'new', { toastIt: false });
            setOpenId(null);
            setTab('works');
            showToast(`Started ${open.title}`);
          }}
          onToTop={async () => {
            const min = Math.min(...pieces.filter((p) => p.stage === 'idea').map((p) => p.display_order ?? 0));
            await patchPiece(open, { display_order: min - 1 });
            showToast('Moved to top');
          }}
          onScrap={() => scrap(open)}
          onRestore={() => patchPiece(open, { is_graveyard: false })}
          onDelete={async () => {
            await api.deletePiece(open.id);
            setPieces((ps) => ps.filter((p) => p.id !== open.id));
            setOpenId(null);
          }}
          onAddPhoto={(f) => addPhoto(open, f)}
          onSetPrimary={(ph) => setPrimary(open, ph)}
          onRemovePhoto={removePhoto}
        />
      )}

      {adding && (
        <AddSheet
          mode={adding}
          extras={api.hasExtras() !== false}
          onClose={() => setAdding(null)}
          onCreate={async (d, file) => {
            const row = await create(d);
            if (file) await addPhoto(row, file);
            setAdding(null);
            showToast(`Added ${row.title}`);
          }}
        />
      )}

      {settings && (
        <Settings
          session={session}
          scrapped={pieces.filter((p) => p.is_graveyard)}
          pieces={pieces}
          photos={photos}
          extras={api.hasExtras()}
          onOpen={(id) => {
            setSettings(false);
            setOpenId(id);
          }}
          onClose={() => setSettings(false)}
          onReload={load}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && <button onClick={toast.undo}>Undo</button>}
        </div>
      )}
    </div>
  );
}

/* ---------------- screens ---------------- */

function Header({ title, sub, onSettings, children }) {
  return (
    <header className="hdr">
      <div className="hdr-row">
        <div>
          <h1>{title}</h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        <button className="icon-btn" aria-label="Settings" onClick={onSettings}>
          <Icon name="gear" />
        </button>
      </div>
      {children}
    </header>
  );
}

/* Drag and drop between stages.
   Touch: press and hold a card (~0.3s) to lift it, then drag. A quick swipe still scrolls.
   Mouse: just drag. */
function useStageDrag(onDrop) {
  const [drag, setDrag] = useState(null); // { piece, x, y, w, h, dx, dy, over }
  const st = useRef({});
  const dragRef = useRef(null);
  dragRef.current = drag;

  useEffect(() => {
    if (!drag) return;
    const blockScroll = (e) => e.cancelable && e.preventDefault();
    document.addEventListener('touchmove', blockScroll, { passive: false });
    document.body.classList.add('dragging');
    let raf;
    const tick = () => {
      const d = dragRef.current;
      if (d) {
        const top = 100;
        const bottom = window.innerHeight - 130;
        let dy = 0;
        if (d.y < top) dy = -Math.min(14, Math.ceil((top - d.y) / 5));
        else if (d.y > bottom) dy = Math.min(14, Math.ceil((d.y - bottom) / 5));
        if (dy) {
          window.scrollBy(0, dy);
          const over = overAt(d.x, d.y);
          if (over !== d.over) setDrag((v) => v && { ...v, over });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('touchmove', blockScroll);
      document.body.classList.remove('dragging');
      cancelAnimationFrame(raf);
    };
  }, [!!drag]);

  const overAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-stage]')?.dataset.stage ?? null;

  // When dragging starts, empty stages open up; keep the lifted card where the finger is.
  useLayoutEffect(() => {
    const a = st.current.anchor;
    if (drag && a) {
      const shift = a.el.getBoundingClientRect().top - a.top;
      if (shift) window.scrollBy(0, shift);
      st.current.anchor = null;
    }
  }, [!!drag]);

  function begin(piece, el, x, y) {
    const r = el.getBoundingClientRect();
    st.current.anchor = { el, top: r.top };
    navigator.vibrate?.(12);
    setDrag({ piece, x, y, w: r.width, h: r.height, dx: x - r.left, dy: y - r.top, over: piece.stage });
  }

  function bind(piece) {
    return {
      onPointerDown(e) {
        if (e.button !== 0) return;
        const el = e.currentTarget;
        const s = (st.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, el, piece, mouse: e.pointerType === 'mouse', moved: false });
        if (!s.mouse) s.timer = setTimeout(() => begin(piece, el, s.x0, s.y0), 320);
      },
      onPointerMove(e) {
        const s = st.current;
        if (s.id !== e.pointerId) return;
        const dist = Math.hypot(e.clientX - s.x0, e.clientY - s.y0);
        if (!dragRef.current) {
          if (dist > 8) {
            clearTimeout(s.timer);
            if (s.mouse) {
              s.el.setPointerCapture?.(e.pointerId);
              begin(piece, s.el, e.clientX, e.clientY);
            } else st.current = {}; // it's a scroll
          }
          return;
        }
        s.moved = true;
        s.lx = e.clientX;
        s.ly = e.clientY;
        setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, over: overAt(e.clientX, e.clientY) });
      },
      onPointerUp(e) {
        const s = st.current;
        clearTimeout(s.timer);
        const d = dragRef.current;
        if (d) {
          const target = overAt(e.clientX, e.clientY) ?? d.over;
          setDrag(null);
          s.suppressClick = true;
          setTimeout(() => (s.suppressClick = false), 50);
          if (target && target !== d.piece.stage) onDrop(d.piece, target);
        }
        st.current = s.suppressClick ? s : {};
      },
      onPointerCancel() {
        clearTimeout(st.current.timer);
        if (dragRef.current) setDrag(null);
        st.current = {};
      },
      onContextMenu(e) {
        e.preventDefault();
      },
      onClickCapture(e) {
        if (st.current.suppressClick) {
          e.stopPropagation();
          e.preventDefault();
          st.current = {};
        }
      },
    };
  }
  return { drag, bind };
}

function Works({ pieces, photoFor, onOpen, onNext, onMove, loading, error, onRetry, onSettings }) {
  const work = pieces.filter((p) => p.stage !== 'completed' && p.stage !== 'idea');
  const { drag, bind } = useStageDrag((p, stage) => onMove(p, stage));
  const groups = WORK_STAGES.map((s) => ({ ...s, items: work.filter((p) => p.stage === s.key).sort((a, b) => (stageSince(a) || a.created_at).localeCompare(stageSince(b) || b.created_at)) }));
  const empty = groups.filter((g) => !g.items.length);
  const shown = drag ? [...groups, { key: 'completed', label: 'Completed', items: [] }] : groups.filter((g) => g.items.length);
  return (
    <main className={`screen ${drag ? 'is-dragging' : ''}`}>
      <Header title="Current Works" sub={drag ? `Drop ${drag.piece.title} on a stage` : loading ? 'Loading…' : `${work.length} in progress`} onSettings={onSettings} />
      {error && (
        <div className="notice">
          <p>Couldn't load your pieces. {error}</p>
          <button className="btn small" onClick={onRetry}>Try again</button>
        </div>
      )}
      {!loading && !error && work.length === 0 && <p className="empty-big">Nothing on the shelves. Tap + after your next studio session.</p>}
      {shown.map((g) => (
        <section key={g.key} data-stage={g.key} className={`stage ${drag ? 'drop' : ''} ${drag?.over === g.key && g.key !== drag.piece.stage ? 'over' : ''} ${g.key === 'completed' ? 'done-zone' : ''}`}>
          <h2>
            <span>{g.key === 'completed' ? 'completed ✓' : g.label.toLowerCase()}</span>
            {g.key !== 'completed' && <span className="count">{g.items.length}</span>}
          </h2>
          {g.items.length > 0 && (
            <div className="group">
              {g.items.map((p) => (
                <WorkCard key={p.id} p={p} photo={photoFor[p.id]} lifted={drag?.piece.id === p.id} handlers={bind(p)} onOpen={() => onOpen(p.id)} onNext={() => onNext(p, nextStage(p.stage).key)} />
              ))}
            </div>
          )}
          {drag && !g.items.length && <div className="drop-hint">{g.key === 'completed' ? 'Drop here when it’s out of the kiln' : 'Drop here'}</div>}
        </section>
      ))}
            {drag && (
        <div className="drag-ghost" style={{ width: drag.w, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) rotate(-1.5deg)` }}>
          <WorkCard p={drag.piece} photo={photoFor[drag.piece.id]} ghost />
        </div>
      )}
    </main>
  );
}

function WorkCard({ p, photo, onOpen, onNext, handlers, lifted, ghost }) {
  const n = nextStage(p.stage);
  const since = stageSince(p);
  const due = dueInfo(p);
  const meta = [since && ago(since), p.description].filter(Boolean).join(' · ');
  return (
    <div className={`card ${lifted ? 'lifted' : ''}`}>
      <button className="card-main" onClick={onOpen} {...handlers}>
        {photo && <img className="thumb" src={photo.url} alt="" loading="lazy" draggable={false} />}
        <span className="card-text">
          <span className="title">
            {p.title}
            {p.is_commission && <span className="dot" title="Commission" />}
          </span>
          {(meta || due) && (
            <span className="meta">
              {meta}
              {due?.urgent && <em className="tag urgent">{due.label}</em>}
            </span>
          )}
        </span>
      </button>
      {n && !ghost && (
        <button className="next" onClick={onNext} aria-label={`Move ${p.title} to ${n.label}`} title={`Move to ${n.label}`}>
          <Icon name="arrow" />
        </button>
      )}
    </div>
  );
}

function Gallery({ pieces, photoFor, onOpen, onSettings }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const list = pieces
    .filter((p) => (filter === 'commissions' ? p.is_commission : filter === 'photos' ? !photoFor[p.id] : true))
    .filter((p) => !q || `${p.title} ${p.description || ''} ${p.glaze || ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  return (
    <main className="screen">
      <Header title="Gallery" sub={`${pieces.length} finished`} onSettings={onSettings}>
        <div className="search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search finished work" />
        </div>
        <div className="chips">
          {[
            ['all', 'All'],
            ['commissions', 'Commissions'],
          ].map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
      </Header>
      <div className="grid">
        {list.map((p) => (
          <button key={p.id} className="tile" onClick={() => onOpen(p.id)}>
            {photoFor[p.id] ? <img src={photoFor[p.id].url} alt="" loading="lazy" /> : <span className="ph">{p.title.charAt(0).toUpperCase()}</span>}
            <span className="tile-name">{p.title}</span>
          </button>
        ))}
      </div>
      {list.length === 0 && <p className="empty-big">Nothing here.</p>}
    </main>
  );
}

function Ideas({ pieces, onOpen, onSettings }) {
  const list = [...pieces].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  return (
    <main className="screen">
      <Header title="Ideas" sub={`${list.length} ideas`} onSettings={onSettings} />
      <div className="group ideas">
        {list.map((p) => {
          const due = dueInfo(p);
          return (
            <button key={p.id} className="idea" onClick={() => onOpen(p.id)}>
              <span className="title">
                {p.title}
                {p.is_commission && <span className="dot" title="Commission" />}
              </span>
              {(p.description || due) && (
                <span className="meta">
                  {[p.description, due?.label].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </main>
  );
}

function SignIn({ onOpenSettings }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="screen signin">
      <div className="pot-mark">
        <Icon name="pot" />
      </div>
      <h1>Jane's pots</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api.signIn(email.trim(), pw);
          } catch (e) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        {err && <p className="err">{err}</p>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <button className="link" onClick={onOpenSettings}>
        Database settings
      </button>
    </main>
  );
}

/* ---------------- sheets ---------------- */

function Sheet({ onClose, children, label }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.classList.add('locked');
    return () => {
      window.removeEventListener('keydown', k);
      document.body.classList.remove('locked');
    };
  }, [onClose]);
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={label}>
        <div className="grab" />
        <button className="icon-btn close" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Text field that saves when you leave it.
function SaveInput({ value, onSave, multiline, ...rest }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => {
    const nv = v.trim() === '' ? null : v.trim();
    if (nv !== (value ?? null)) onSave(nv);
  };
  const El = multiline ? 'textarea' : 'input';
  return <El value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => !multiline && e.key === 'Enter' && e.target.blur()} rows={multiline ? 2 : undefined} {...rest} />;
}

function PieceSheet({ piece: p, photos, extras, onClose, onPatch, onStage, onStart, onToTop, onScrap, onRestore, onDelete, onAddPhoto, onSetPrimary, onRemovePhoto }) {
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState(null);
  const isIdea = p.stage === 'idea';
  const sorted = [...photos].sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
  const history = STAGES.filter((s) => p.stage_dates?.[s.key]).map((s) => [s.label, p.stage_dates[s.key]]);
  return (
    <Sheet onClose={onClose} label={p.title}>
      <SaveInput className="title-input" value={p.title} onSave={(v) => v && onPatch({ title: v })} aria-label="Title" />
      <p className="sheet-sub">
        {p.is_graveyard ? 'Scrapped · ' : ''}
        {stageLabel(p.stage)}
        {p.stage === 'completed' && p.completed_at ? ` · ${fmtDate(p.completed_at)}` : stageSince(p) ? ` · ${ago(stageSince(p))}` : ''}
      </p>

      <div className="photos">
        {sorted.map((ph) => (
          <button key={ph.id} className={`photo ${ph.is_primary ? 'primary' : ''}`} onClick={() => setViewer(ph)}>
            <img src={ph.url} alt="" />
          </button>
        ))}
        <button className="photo add" onClick={() => fileRef.current.click()} disabled={busy}>
          <Icon name="camera" />
          <span>{busy ? 'Uploading…' : 'Add photo'}</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true);
            try {
              await onAddPhoto(f);
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>

      {isIdea ? (
        <div className="row-btns">
          <button className="btn primary" onClick={onStart}>
            Start this piece
          </button>
          <button className="btn" onClick={onToTop}>
            Move to top
          </button>
        </div>
      ) : (
        <>
          <h3>Stage</h3>
          <div className="chips wrap">
            {STAGES.map((s) => (
              <button key={s.key} className={`chip ${p.stage === s.key ? 'on' : ''}`} onClick={() => onStage(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}

      <Field label="Notes">
        <SaveInput multiline value={p.description} onSave={(v) => onPatch({ description: v })} placeholder="Who it's for, size, anything" />
      </Field>
      {extras && (
        <>
          <div className="two">
            <Field label="Clay">
              <SaveInput value={p.clay} onSave={(v) => onPatch({ clay: v })} placeholder="e.g. speckled buff" />
            </Field>
            <Field label="Due">
              <input type="date" value={p.due_date || ''} onChange={(e) => onPatch({ due_date: e.target.value || null })} />
            </Field>
          </div>
          <Field label="Glaze">
            <SaveInput value={p.glaze} onSave={(v) => onPatch({ glaze: v })} placeholder="e.g. celadon, 2 coats" />
          </Field>
        </>
      )}
      <label className="toggle">
        <input type="checkbox" checked={!!p.is_commission} onChange={(e) => onPatch({ is_commission: e.target.checked })} />
        <span>Commission</span>
      </label>

      {history.length > 0 && !isIdea && (
        <>
          <h3>History</h3>
          <ul className="history">
            {history.map(([l, d]) => (
              <li key={l}>
                <span>{l}</span>
                <span>{fmtDate(d)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="danger">
        {p.is_graveyard ? (
          <>
            <button className="btn" onClick={onRestore}>
              Restore
            </button>
            <button
              className="btn warn"
              onClick={() => {
                if (confirm(`Delete "${p.title}" forever? This can't be undone.`)) onDelete();
              }}
            >
              Delete forever
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={onScrap}>
            <Icon name="trash" /> Scrap
          </button>
        )}
      </div>

      {viewer && (
        <div className="viewer" onClick={() => setViewer(null)}>
          <img src={viewer.url} alt="" />
          <div className="viewer-btns" onClick={(e) => e.stopPropagation()}>
            {!viewer.is_primary && (
              <button
                className="btn small"
                onClick={() => {
                  onSetPrimary(viewer);
                  setViewer(null);
                }}
              >
                Make cover
              </button>
            )}
            <button
              className="btn small warn"
              onClick={() => {
                if (confirm('Remove this photo?')) {
                  onRemovePhoto(viewer);
                  setViewer(null);
                }
              }}
            >
              Remove
            </button>
            <button className="btn small" onClick={() => setViewer(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function AddSheet({ mode, extras, onClose, onCreate }) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [stage, setStage] = useState(mode === 'idea' ? 'idea' : 'new');
  const [commission, setCommission] = useState(false);
  const [due, setDue] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef();
  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 250);
  }, []);
  return (
    <Sheet onClose={onClose} label={mode === 'idea' ? 'New idea' : 'New piece'}>
      <h2 className="sheet-title">{mode === 'idea' ? 'New idea' : 'New piece'}</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          setBusy(true);
          setErr(null);
          try {
            await onCreate(
              {
                title: title.trim(),
                description: desc.trim() || null,
                stage,
                is_commission: commission,
                ...(extras && due ? { due_date: due } : {}),
              },
              file
            );
          } catch (e) {
            setErr(e.message);
            setBusy(false);
          }
        }}
      >
        <input ref={ref} className="big-input" placeholder={mode === 'idea' ? 'What do you want to make?' : 'Title'} value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea placeholder="Notes (optional)" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        {mode !== 'idea' && (
          <>
            <h3>Starting stage</h3>
            <div className="chips wrap">
              {STAGES.map((s) => (
                <button type="button" key={s.key} className={`chip ${stage === s.key ? 'on' : ''}`} onClick={() => setStage(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="two">
          <label className="toggle">
            <input type="checkbox" checked={commission} onChange={(e) => setCommission(e.target.checked)} />
            <span>Commission</span>
          </label>
          {extras && (
            <Field label="Due (optional)">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          )}
        </div>
        <label className="btn ghost file">
          <Icon name="camera" /> {file ? file.name.slice(0, 24) : 'Add a photo'}
          <input type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        {err && <p className="err">{err}</p>}
        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !title.trim()}>
            {busy ? 'Adding…' : mode === 'idea' ? 'Add idea' : 'Add piece'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function Settings({ session, scrapped, pieces, photos, extras, onOpen, onClose, onReload }) {
  const cfg = getConfig();
  const [url, setUrl] = useState(cfg.url);
  const [key, setKey] = useState(cfg.key);
  const [progress, setProgress] = useState(null);
  const [showScrap, setShowScrap] = useState(false);
  return (
    <Sheet onClose={onClose} label="Settings">
      <h2 className="sheet-title">Settings</h2>

      <h3>Account</h3>
      {api.demo ? (
        <p className="muted">Demo mode: nothing is saved.</p>
      ) : session ? (
        <div className="row-between">
          <span className="muted">Signed in as {session.user.email}</span>
          <button className="btn small" onClick={() => api.signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <p className="muted">{isUsingOldDatabase() ? 'Using the old Bolt database (no sign-in).' : 'Not signed in.'}</p>
      )}

      <h3>Scrapped pieces ({scrapped.length})</h3>
      <button className="btn small" onClick={() => setShowScrap(!showScrap)}>
        {showScrap ? 'Hide' : 'Show'}
      </button>
      {showScrap && (
        <ul className="plain">
          {scrapped.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => onOpen(p.id)}>
                {p.title}
              </button>{' '}
              <span className="muted">· {stageLabel(p.stage)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Backup</h3>
      <p className="muted">Downloads every piece and photo link as a file.</p>
      <button
        className="btn small"
        onClick={() => {
          const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), pieces, photos }, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `pots-backup-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
        }}
      >
        Download backup
      </button>

      {!isUsingOldDatabase() && !api.demo && (
        <>
          <h3>Copy from the Bolt version</h3>
          <p className="muted">Copies all pieces, ideas and photos from the old database into this one. Safe to run twice.</p>
          <button
            className="btn small"
            disabled={!!progress && !progress.done}
            onClick={async () => {
              try {
                const r = await api.importFromOld((m) => setProgress({ msg: m }));
                setProgress({ msg: `Done: ${r.pieces} pieces, ${r.photos} photos.`, done: true });
                onReload();
              } catch (e) {
                setProgress({ msg: `Stopped: ${e.message}`, done: true });
              }
            }}
          >
            Copy everything
          </button>
          {progress && <p className="muted">{progress.msg}</p>}
        </>
      )}

      <h3>Database</h3>
      {extras === false && <p className="muted">Clay, glaze, due dates and stage history are off until the setup SQL is run on this database.</p>}
      <Field label="Supabase URL">
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Anon key">
        <input value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="row-btns">
        <button
          className="btn small"
          onClick={() => {
            setConfig(null);
            location.reload();
          }}
        >
          Reset
        </button>
        <button
          className="btn small primary"
          onClick={() => {
            setConfig({ url: url.trim(), key: key.trim() });
            location.reload();
          }}
        >
          Save & reload
        </button>
      </div>
      <p className="muted tiny">Jane's pots · v1</p>
    </Sheet>
  );
}
