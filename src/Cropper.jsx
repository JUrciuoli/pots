import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SHAPES = [
  { key: 'square', label: 'Square', ratio: 1 },
  { key: 'portrait', label: 'Portrait', ratio: 5 / 4 }, // height / width
  { key: 'full', label: 'Full', ratio: null },
];

/* Full-screen cropper: drag to move, pinch / slider / scroll wheel to zoom. */
export default function Cropper({ file, onCancel, onDone }) {
  const [img, setImg] = useState(null); // { url, w, h }
  const [shape, setShape] = useState('square');
  const [box, setBox] = useState({ w: 300, h: 300 });
  const [view, setView] = useState({ s: 1, x: 0, y: 0 }); // scale and top-left offset of the image inside the frame
  const [busy, setBusy] = useState(false);
  const stageRef = useRef();
  const pointers = useRef(new Map());
  const gesture = useRef(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => setImg({ url, w: im.naturalWidth, h: im.naturalHeight, el: im });
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // frame size for the chosen shape
  useLayoutEffect(() => {
    if (!img || !stageRef.current) return;
    const maxW = stageRef.current.clientWidth - 32;
    const maxH = stageRef.current.clientHeight - 32;
    const ratio = SHAPES.find((s) => s.key === shape).ratio ?? img.h / img.w;
    let w = maxW, h = w * ratio;
    if (h > maxH) { h = maxH; w = h / ratio; }
    setBox({ w, h });
    const s = Math.max(w / img.w, h / img.h);
    setView({ s, x: (w - img.w * s) / 2, y: (h - img.h * s) / 2 });
  }, [img, shape]);

  const minScale = img ? Math.max(box.w / img.w, box.h / img.h) : 1;
  const clamp = (v) => {
    if (!img) return v;
    const s = Math.min(Math.max(v.s, minScale), minScale * 6);
    const iw = img.w * s, ih = img.h * s;
    return { s, x: Math.min(0, Math.max(box.w - iw, v.x)), y: Math.min(0, Math.max(box.h - ih, v.y)) };
  };
  // zoom keeping the point (px, py) in the frame fixed
  const zoomAt = (v, ns, px, py) => {
    const k = ns / v.s;
    return { s: ns, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  };

  function framePoint(e) {
    const r = stageRef.current.querySelector('.crop-frame').getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onDown(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, framePoint(e));
    startGesture();
  }
  function startGesture() {
    const pts = [...pointers.current.values()];
    if (pts.length === 1) gesture.current = { type: 'pan', p: pts[0], v: view };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      gesture.current = { type: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v: view };
    }
  }
  function onMove(e) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, framePoint(e));
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (!g) return;
    if (g.type === 'pan' && pts.length === 1) {
      const [x, y] = pts[0];
      setView(clamp({ ...g.v, x: g.v.x + x - g.p[0], y: g.v.y + y - g.p[1] }));
    } else if (g.type === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = zoomAt(g.v, g.v.s * (d / g.d), g.m[0], g.m[1]);
      setView(clamp({ ...z, x: z.x + m[0] - g.m[0], y: z.y + m[1] - g.m[1] }));
    }
  }
  function onUp(e) {
    pointers.current.delete(e.pointerId);
    startGesture();
    if (!pointers.current.size) gesture.current = null;
  }
  function onWheel(e) {
    const [px, py] = framePoint(e);
    setView((v) => clamp(zoomAt(v, v.s * Math.exp(-e.deltaY / 400), px, py)));
  }

  async function done() {
    setBusy(true);
    const { s, x, y } = view;
    const sx = -x / s, sy = -y / s, sw = box.w / s, sh = box.h / s;
    const out = Math.min(2000 / Math.max(sw, sh), 1);
    const c = document.createElement('canvas');
    c.width = Math.round(sw * out);
    c.height = Math.round(sh * out);
    c.getContext('2d').drawImage(img.el, sx, sy, sw, sh, 0, 0, c.width, c.height);
    c.toBlob((b) => onDone(b || file), 'image/jpeg', 0.9);
  }

  const zoom = img ? view.s / minScale : 1;
  // Rendered straight into <body> so no panel or scroll area can clip it.
  return createPortal(
    <div className="cropper" role="dialog" aria-label="Crop photo">
      <div className="crop-top">
        <button className="crop-text" onClick={onCancel}>Cancel</button>
        <span>Crop</span>
        <button className="crop-text strong" onClick={done} disabled={!img || busy}>{busy ? 'Saving…' : 'Done'}</button>
      </div>
      <div className="crop-stage" ref={stageRef} onWheel={onWheel}>
        {img && (
          <div
            className="crop-frame"
            style={{ width: box.w, height: box.h }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <img
              src={img.url}
              alt=""
              draggable={false}
              style={{ width: img.w * view.s, height: img.h * view.s, transform: `translate(${view.x}px, ${view.y}px)` }}
            />
            <div className="crop-grid" />
          </div>
        )}
      </div>
      <div className="crop-bottom">
        <input
          type="range"
          min="1"
          max="6"
          step="0.01"
          value={zoom}
          aria-label="Zoom"
          onChange={(e) => setView((v) => clamp(zoomAt(v, minScale * Number(e.target.value), box.w / 2, box.h / 2)))}
        />
        <div className="crop-shapes">
          {SHAPES.map((s) => (
            <button key={s.key} className={`chip ${shape === s.key ? 'on' : ''}`} onClick={() => setShape(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <button className="crop-use" onClick={done} disabled={!img || busy}>
          {busy ? 'Saving…' : 'Use photo'}
        </button>
      </div>
    </div>,
    document.body
  );
}
