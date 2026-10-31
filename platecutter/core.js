// Plate Cutter — image analysis core (no DOM). Works on plain typed arrays.
'use strict';

const Core = (() => {

  // ---------- plate preparation ----------
  // plate = {W,H,rgba(Uint8ClampedArray), L(Float32 luminance), S(Float32 local 3x3 std)}
  function preparePlate(imageData) {
    const W = imageData.width, H = imageData.height, d = imageData.data;
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) L[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
    const S = localStd(L, W, H);
    return { W, H, rgba: d, L, S };
  }

  function localStd(L, W, H) {
    // 3x3 box mean / mean of squares via separable sums
    const n = W * H, m = new Float32Array(n), q = new Float32Array(n), tm = new Float32Array(n), tq = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      const r = y * W;
      for (let x = 0; x < W; x++) {
        let s = 0, s2 = 0, c = 0;
        for (let k = -1; k <= 1; k++) { const xx = x + k; if (xx < 0 || xx >= W) continue; const v = L[r + xx]; s += v; s2 += v * v; c++; }
        tm[r + x] = s / c; tq[r + x] = s2 / c;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, s2 = 0, c = 0;
        for (let k = -1; k <= 1; k++) { const yy = y + k; if (yy < 0 || yy >= H) continue; s += tm[yy * W + x]; s2 += tq[yy * W + x]; c++; }
        m[y * W + x] = s / c; q[y * W + x] = s2 / c;
      }
    }
    const S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = Math.sqrt(Math.max(0, q[i] - m[i] * m[i]));
    return S;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = Float32Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(p / 100 * (a.length - 1))))];
  }

  // ---------- tones ----------
  // gutter: a little above the 3rd percentile of smooth pixels (the mount is the darkest smooth thing)
  // paper: median of the image's outer ring, if it's light
  function estimateTones(pl) {
    const { W, H, L, S } = pl, smooth = [];
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 400000)));
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) { const i = y * W + x; if (S[i] < 4) smooth.push(L[i]); }
    const gutter = Math.round(percentile(smooth, 3) + 4);
    const ring = [];
    for (let x = 0; x < W; x += 2) for (let k = 0; k < 6; k++) { ring.push(L[k * W + x]); ring.push(L[(H - 1 - k) * W + x]); }
    for (let y = 0; y < H; y += 2) for (let k = 0; k < 6; k++) { ring.push(L[y * W + k]); ring.push(L[y * W + W - 1 - k]); }
    const pm = percentile(ring, 50);
    return { gutter, paper: pm > 165 ? Math.round(pm) : null };
  }

  function bgLike(pl, tones, i) {
    if (pl.S[i] >= 4) return false;
    const v = pl.L[i];
    if (Math.abs(v - tones.gutter) < 12) return true;
    if (tones.paper != null && Math.abs(v - tones.paper) < 22) return true;
    return false;
  }

  // ---------- grid detection ----------
  function rowProfile(pl, tones) {
    const { W, H } = pl, prof = new Float32Array(H);
    for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) if (bgLike(pl, tones, y * W + x)) c++; prof[y] = c / W; }
    return prof;
  }
  function colProfile(pl, tones, y0, y1) {
    const { W } = pl, prof = new Float32Array(W);
    const h = y1 - y0, a = Math.round(y0 + h * 0.12), b = Math.round(y1 - h * 0.12), n = Math.max(1, b - a);
    for (let x = 0; x < W; x++) { let c = 0; for (let y = a; y < b; y++) if (bgLike(pl, tones, y * W + x)) c++; prof[x] = c / n; }
    return prof;
  }

  // turn a gutter profile into separator lines (gutter centers), optionally forcing a cell count
  function separators(prof, minw, count) {
    const n = prof.length, theta = 0.85 * percentile(prof, 99.5);
    const bands = [];
    for (let i = 0; i < n;) {
      if (prof[i] >= theta) { let j = i; while (j < n && prof[j] >= theta) j++; bands.push([i, j]); i = j; } else i++;
    }
    const merged = [];
    for (const b of bands) {
      if (merged.length && b[0] - merged[merged.length - 1][1] < minw) merged[merged.length - 1][1] = b[1];
      else merged.push(b.slice());
    }
    // interior gutters: centre line; outer margins: the outer end, so crops keep the whole margin
    let lines = merged.map(([a, b], k) => k === 0 && a <= minw ? a : k === merged.length - 1 && b >= n - minw ? b : Math.round((a + b) / 2));
    if (!merged.length || merged[0][0] > minw) lines.unshift(0);
    if (!merged.length || merged[merged.length - 1][1] < n - minw) lines.push(n);
    lines = [...new Set(lines)].sort((a, b) => a - b);
    const best = (lo, hi) => { lo = Math.max(1, Math.round(lo)); hi = Math.min(n - 1, Math.round(hi)); let bi = lo, bv = -1; for (let i = lo; i < hi; i++) if (prof[i] > bv) { bv = prof[i]; bi = i; } return bi; };
    const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    // split cells that are clearly two or more frames
    for (let it = 0; it < 60 && lines.length > 2; it++) {
      const w = lines.slice(1).map((v, i) => v - lines[i]); const med = median(w);
      let k = 0; for (let i = 1; i < w.length; i++) if (w[i] > w[k]) k = i;
      if (w[k] < 1.6 * med) break;
      const parts = Math.round(w[k] / med), add = [];
      for (let q = 1; q < parts; q++) { const c = lines[k] + q * w[k] / parts, r = 0.2 * med; add.push(best(c - r, c + r)); }
      lines = [...lines, ...add].sort((a, b) => a - b);
    }
    // a sliver cell (well under the usual frame width) is a false line: drop the weaker of its two lines
    for (let it = 0; it < 40 && lines.length > 3; it++) {
      const w = lines.slice(1).map((v, i) => v - lines[i]), med = median(w);
      let k = 0; for (let i = 1; i < w.length; i++) if (w[i] < w[k]) k = i;
      if (w[k] >= 0.6 * med) break;
      const a = k, b = k + 1;   // line indices bounding the sliver
      if (a === 0) lines.splice(b, 1); else if (b === lines.length - 1) lines.splice(a, 1);
      else lines.splice(prof[lines[a]] >= prof[lines[b]] ? b : a, 1);
    }
    if (count && count > 0) lines = forceCount(lines, prof, count, best);
    return lines;
  }

  function forceCount(lines, prof, count, best) {
    lines = lines.slice();
    let guard = 200;
    while (lines.length - 1 > count && guard--) {
      // drop the interior separator whose removal makes the narrowest merged cell
      let bi = 1, bw = Infinity;
      for (let i = 1; i < lines.length - 1; i++) { const w = lines[i + 1] - lines[i - 1]; if (w < bw) { bw = w; bi = i; } }
      if (lines.length <= 2) break;
      lines.splice(bi, 1);
    }
    while (lines.length - 1 < count && guard--) {
      let k = 0; for (let i = 1; i < lines.length - 1; i++) if (lines[i + 1] - lines[i] > lines[k + 1] - lines[k]) k = i;
      const w = lines[k + 1] - lines[k], c = lines[k] + w / 2;
      lines.splice(k + 1, 0, best(c - w * 0.2, c + w * 0.2));
    }
    return lines;
  }

  function detectGrid(pl, tones, opts = {}) {
    const rows = separators(rowProfile(pl, tones), 0.08 * pl.H, opts.rowCount);
    const cols = [];
    for (let r = 0; r < rows.length - 1; r++) cols.push(detectCols(pl, tones, rows[r], rows[r + 1], opts.colCount && opts.colCount[r]));
    return { rows, cols };
  }
  function detectCols(pl, tones, y0, y1, count) {
    let lines = separators(colProfile(pl, tones, y0, y1), 0.025 * pl.W, count);
    { const ws = lines.slice(1).map((v, i) => v - lines[i]).sort((a, b) => a - b), mw = ws[Math.floor(ws.length / 2)] || 200;
      lines = snapCols(pl, lines, y0, y1, Math.max(12, Math.round(mw * 0.08))); }
    // frames in a row share one pitch: fit x_k ≈ x0 + k·p to the interior lines, re-snap any that stray
    const n = lines.length;
    if (n >= 5) {
      const med = a => { const q = a.slice().sort((x, y) => x - y); return q[Math.floor(q.length / 2)]; };
      const inner = lines.slice(1, -1), k0 = 1;
      let p = med(inner.slice(1).map((v, i) => v - inner[i]));
      // robust fit: try every pair of interior lines as the pitch estimate, keep the one most lines agree with
      let bestFit = null, bestAgree = -1;
      for (let i = 0; i < inner.length; i++) for (let j = i + 1; j < inner.length; j++) {
        const pp = (inner[j] - inner[i]) / (j - i); if (Math.abs(pp - p) > p * 0.15) continue;
        const x0 = inner[i] - (i + k0) * pp; let agree = 0;
        inner.forEach((v, q) => { if (Math.abs(v - (x0 + (q + k0) * pp)) <= 6) agree++; });
        if (agree > bestAgree) { bestAgree = agree; bestFit = [x0, pp]; }
      }
      if (bestFit && bestAgree >= Math.min(3, inner.length)) {
        const [x0, pp] = bestFit, fixed = lines.slice();
        for (let k = 1; k < n - 1; k++) {
          const f = x0 + k * pp;
          if (Math.abs(lines[k] - f) <= 6) continue;
          const cand = snapCols(pl, [0, Math.round(f), pl.W], y0, y1, 6)[1];
          // only move when the spot the pitch predicts looks more like a gutter than where we are
          if (lineScore(pl, cand, y0, y1) < lineScore(pl, lines[k], y0, y1) - 3) fixed[k] = cand;
        }
        lines = fixed;
      }
    }
    return lines;
  }
  function lineScore(pl, x, y0, y1) {
    const h = y1 - y0, a = Math.round(y0 + h * .12), b = Math.round(y1 - h * .12); let s = 0, s2 = 0, n = 0;
    for (let y = a; y < b; y += 2) { const v = pl.L[y * pl.W + x]; s += v; s2 += v * v; n++; }
    const m = s / n; return m + 0.5 * Math.sqrt(Math.max(0, s2 / n - m * m));
  }
  // Interior column lines: move onto the darkest, most even vertical line nearby (the gutter, even when
  // it is only a hairline between two dark frames).
  function snapCols(pl, lines, y0, y1, r = 12) {
    const h = y1 - y0, a = Math.round(y0 + h * .12), b = Math.round(y1 - h * .12);
    return lines.map((x, k) => {
      if (k === 0 || k === lines.length - 1) return x;
      let bx = x, bv = Infinity;
      for (let xx = Math.max(1, x - r); xx <= Math.min(pl.W - 2, x + r); xx++) {
        let s = 0, s2 = 0, n = 0;
        for (let y = a; y < b; y += 2) { const v = pl.L[y * pl.W + xx]; s += v; s2 += v * v; n++; }
        const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m)), v = m + 0.5 * sd + Math.abs(xx - x) * 0.3;
        if (v < bv) { bv = v; bx = xx; }
      }
      return bx;
    });
  }

  // ---------- cutting one frame ----------
  // cell: [x0,y0,x1,y1] in plate px. polys: arrays of [x,y] in crop coords (protected = always image).
  // Returns {x,y,w,h, alpha:Uint8Array, rect:{l,t,r,b} (crop coords), center:[cx,cy], gutterRGB}
  function cutFrame(pl, tones, cell, o, polysFn) {
    const bleed = o.bleed, tol = o.tol, sT = o.smooth, slack = o.depth, soft = o.soft;
    const X0 = Math.max(0, Math.round(cell[0] - bleed)), Y0 = Math.max(0, Math.round(cell[1] - bleed));
    const X1 = Math.min(pl.W, Math.round(cell[2] + bleed)), Y1 = Math.min(pl.H, Math.round(cell[3] + bleed));
    const w = X1 - X0, h = Y1 - Y0, n = w * h;
    const l = new Float32Array(n), s = new Float32Array(n);
    for (let y = 0; y < h; y++) { const src = (Y0 + y) * pl.W + X0; l.set(pl.L.subarray(src, src + w), y * w); s.set(pl.S.subarray(src, src + w), y * w); }

    // line profiles over the middle 60%
    const mx0 = Math.floor(w * .2), mx1 = Math.ceil(w * .8), my0 = Math.floor(h * .2), my1 = Math.ceil(h * .8);
    const prof = (horiz, rev) => {
      const len = horiz ? h : w, pl_ = new Float32Array(len), ps_ = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const ii = rev ? len - 1 - i : i; let sl = 0, ss = 0, c = 0;
        if (horiz) { for (let x = mx0; x < mx1; x++) { sl += l[ii * w + x]; ss += s[ii * w + x]; c++; } }
        else { for (let y = my0; y < my1; y++) { sl += l[y * w + ii]; ss += s[y * w + ii]; c++; } }
        pl_[i] = sl / c; ps_[i] = ss / c;
      }
      return [pl_, ps_];
    };
    const base = [tones.gutter]; if (tones.paper != null) base.push(tones.paper);
    const side = ([pv, ps], maxd) => {
      const nn = Math.min(maxd, pv.length), like = new Uint8Array(nn);
      for (let i = 0; i < nn; i++) { let ok = false; for (const t of base) if (Math.abs(pv[i] - t) < 12) ok = true; like[i] = ok && ps[i] < 3.5 ? 1 : 0; }
      let A = -1, B = -1;
      for (let i = 0; i < nn;) { if (like[i]) { let j = i; while (j < nn && like[j]) j++; if (j - i > B - A) { A = i; B = j; } i = j; } else i++; }
      if (A < 0) return { a: 0, b: 0, tone: null };
      const mean = (arr, a, b) => { let t = 0; for (let k = a; k < b; k++) t += arr[k]; return t / Math.max(1, b - a); };
      for (let i = A + 2; i < B - 1; i++) {
        const jump = mean(pv, i, i + 3) - mean(pv, Math.max(A, i - 4), i);
        if (Math.abs(jump) >= 40) continue; // e.g. paper → mount: both are background
        if (Math.abs(jump) >= 4.5 || mean(ps, i, i + 3) > 1.8 * mean(ps, Math.max(A, i - 4), i) + 0.8) { B = i; break; }
      }
      const seg = Array.from(pv.subarray(A, B)).sort((x, y) => x - y);
      return { a: A, b: B, tone: seg[Math.floor(seg.length / 2)] };
    };
    const T = side(prof(true, false), Math.floor(h * .35)), Bm = side(prof(true, true), Math.floor(h * .35));
    const Lf = side(prof(false, false), Math.floor(w * .35)), Rt = side(prof(false, true), Math.floor(w * .35));
    // fixed rectangle (from the row's consensus): sides sit exactly there, and anything more than
    // `margin` px outside it is dropped, so every frame comes out roughly the same rectangle
    const rf = o.rectFix;
    if (rf) {
      const margin = Math.max(3, o.depth);
      const fix = (sd, e, len) => { e = Math.round(e); if (e < 0 || e >= len) { sd.a = 0; sd.b = Math.max(0, Math.min(len - 1, e)); return; } sd.b = e; sd.a = Math.max(0, e - margin); };
      fix(T, rf.t - Y0, h); fix(Bm, Y1 - rf.b, h); fix(Lf, rf.l - X0, w); fix(Rt, X1 - rf.r, w);
    }
    const top = T.b, bot = h - Bm.b, lft = Lf.b, rgt = w - Rt.b;
    const tonesArr = base.slice(); for (const sd of [T, Bm, Lf, Rt]) if (sd.tone != null) tonesArr.push(sd.tone);

    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 1e9; for (const t of tonesArr) { const v = Math.abs(l[i] - t); if (v < m) m = v; } d[i] = m; }

    // zones
    const outer = new Uint8Array(n), inner = new Uint8Array(n), cutaway = new Uint8Array(n), cl = o.clip;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inRect = y >= top && y < bot && x >= lft && x < rgt;
      outer[i] = inRect ? 0 : 1;
      inner[i] = inRect && !(y >= top + slack && y < bot - slack && x >= lft + slack && x < rgt - slack) ? 1 : 0;
      cutaway[i] = (y < T.a || y >= h - Bm.a || x < Lf.a || x >= w - Rt.a || (cl && ((cl.l != null && X0 + x < cl.l) || (cl.r != null && X0 + x >= cl.r) || (cl.t != null && Y0 + y < cl.t) || (cl.b != null && Y0 + y >= cl.b)))) ? 1 : 0;
    }
    let pass = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const sm = s[i] < sT;
      pass[i] = ((d[i] < tol && sm && outer[i]) || (d[i] < tol * 0.4 && sm && inner[i]) || cutaway[i]) ? 1 : 0;
    }
    // remove thin smooth paths inside the frame (leak guard), keep everything outside the rect
    const opened = dilate(erode(pass, w, h), w, h);
    for (let i = 0; i < n; i++) pass[i] = opened[i] || (pass[i] && outer[i]) ? 1 : 0;

    // protect polygons
    const prot = new Uint8Array(n);
    const center = [(lft + rgt) / 2, (top + bot) / 2];
    const polys = polysFn ? polysFn(center) : [];
    for (const poly of polys) fillPoly(prot, w, h, poly);
    for (let i = 0; i < n; i++) if (prot[i]) pass[i] = 0;

    // flood fill from the crop border
    const F = new Uint8Array(n), q = new Int32Array(n); let qh = 0, qt = 0;
    const seed = i => { if (pass[i] && !F[i]) { F[i] = 1; q[qt++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i - x) / w;
      if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (y > 0) seed(i - w); if (y < h - 1) seed(i + w);
    }

    // alpha: transparent where filled, ramp in a 2px band next to the fill
    const alpha = new Uint8Array(n);
    let band = F; band = dilate(dilate(band, w, h), w, h);
    const lo = tol * 0.4, span = Math.max(1, tol * 1.6 * soft);
    for (let i = 0; i < n; i++) {
      if (F[i]) alpha[i] = 0;
      else if (band[i] && !prot[i]) alpha[i] = Math.round(255 * Math.min(1, Math.max(0, (d[i] - lo) / span)));
      else alpha[i] = 255;
    }

    // islands: keep the biggest; drop border-touching ones; specks optional
    const lab = new Int32Array(n); let nl = 0; const sizes = [0], touches = [false];
    for (let i = 0; i < n; i++) {
      if (!alpha[i] || lab[i]) continue;
      nl++; let size = 0, touch = false; lab[i] = nl; q[0] = i; qh = 0; qt = 1;
      while (qh < qt) {
        const j = q[qh++], x = j % w, y = (j - x) / w; size++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch = true;
        const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
        for (const k of nb) if (k >= 0 && alpha[k] && !lab[k]) { lab[k] = nl; q[qt++] = k; }
      }
      sizes.push(size); touches.push(touch);
    }
    let main = 1; for (let k = 2; k <= nl; k++) if (sizes[k] > sizes[main]) main = k;
    const keepLab = new Uint8Array(nl + 1);
    for (let k = 1; k <= nl; k++) keepLab[k] = k === main || (o.keepSpecks && !touches[k] && sizes[k] <= o.speckMax) ? 1 : 0;
    for (let i = 0; i < n; i++) if (alpha[i] && !keepLab[lab[i]]) alpha[i] = 0;

    // gutter colour for defringing: mean RGB of filled pixels near the image
    let gr = 0, gg = 0, gb = 0, gc = 0;
    for (let i = 0; i < n; i++) if (F[i] && band[i]) { const x = i % w, y = (i - x) / w, p = ((Y0 + y) * pl.W + X0 + x) * 4; gr += pl.rgba[p]; gg += pl.rgba[p + 1]; gb += pl.rgba[p + 2]; gc++; }
    const gutterRGB = gc ? [gr / gc, gg / gc, gb / gc] : [tones.gutter, tones.gutter, tones.gutter];

    return { x: X0, y: Y0, w, h, alpha, rect: { l: lft, t: top, r: rgt, b: bot }, center, gutterRGB, cell, snapped: [T, Bm, Lf, Rt].some(sd => sd.snapped) };
  }

  // Cut a whole row. Frames in a row are prints of one size, so:
  // 1) cut each frame and find its straight edges, 2) take the row's median width and height,
  // 3) place a rectangle of exactly that size on each frame where the edge evidence is strongest,
  // 4) re-cut with that rectangle fixed.
  function cutRow(pl, tones, cells, o, polysFor, rectFor = () => null) {
    const clipOf = cell => ({ l: cell[0] > 0 ? cell[0] - 1 : null, r: cell[2] < pl.W ? cell[2] + 1 : null, t: cell[1] > 0 ? cell[1] - 1 : null, b: cell[3] < pl.H ? cell[3] + 1 : null });
    const first = cells.map((cell, c) => cutFrame(pl, tones, cell, { ...o, clip: clipOf(cell) }, polysFor(c)));
    if (cells.length < 2 && !rectFor(0)) return first;
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const R = first.map(k => ({ l: k.x + k.rect.l, t: k.y + k.rect.t, r: k.x + k.rect.r, b: k.y + k.rect.b }));
    const mw = Math.round(med(R.map(q => q.r - q.l))), mh = Math.round(med(R.map(q => q.b - q.t)));
    const mt = med(R.map(q => q.t)), mb = med(R.map(q => q.b));
    const base = [tones.gutter]; if (tones.paper != null) base.push(tones.paper);
    const bgf = i => { if (pl.S[i] >= 4) return 0; for (const t of base) if (Math.abs(pl.L[i] - t) < 12) return 1; return 0; };
    // how much a line looks like "background on the outside, picture on the inside"
    const edgeScore = (vert, pos, outSign, a0, a1) => {
      let so = 0, si = 0, fo = 0, fi = 0, c = 0;
      a0 = Math.max(0, Math.round(a0)); a1 = Math.min(vert ? pl.H : pl.W, Math.round(a1));
      for (let u = a0; u < a1; u += 2) for (let k = 1; k <= 3; k++) {
        const po = Math.round(pos + outSign * k), pi = Math.round(pos - outSign * (k - 1));
        if (vert) { if (po < 0 || po >= pl.W || pi < 0 || pi >= pl.W) continue; const io = u * pl.W + po, ii = u * pl.W + pi; so += pl.L[io]; si += pl.L[ii]; fo += bgf(io); fi += bgf(ii); }
        else { if (po < 0 || po >= pl.H || pi < 0 || pi >= pl.H) continue; const io = po * pl.W + u, ii = pi * pl.W + u; so += pl.L[io]; si += pl.L[ii]; fo += bgf(io); fi += bgf(ii); }
        c++;
      }
      if (!c) return 0;
      fo /= c; fi /= c;
      // outside must look like gutter/paper; a capped tone step helps on light frames
      return 20 * (fo - fi) + Math.min(15, Math.abs(so - si) / c) - (fo < 0.6 ? 30 * (0.6 - fo) / 0.6 + 10 : 0);
    };
    return first.map((k, c) => {
      const q = R[c];
      const cand = (l, t) => ({ l, t, r: l + mw, b: t + mh });
      // vertical: a row is one strip, so stay near the row's median top; horizontal: anchor on either detected side
      const cl = clipOf(cells[c]), cL = cl.l != null ? cl.l + 1 : -Infinity, cR = cl.r != null ? cl.r - 1 : Infinity;
      let xs = [q.l, q.r - mw, (q.l + q.r - mw) / 2];
      if (cl.l != null) xs.push(cL + 1); if (cl.r != null) xs.push(cR - 1 - mw); if (cl.l != null && cl.r != null) xs.push((cL + cR - mw) / 2);
      // a frame lives inside its own cell (grid lines are borders)
      xs = xs.filter(x => x >= cL - 2 && x + mw <= cR + 2);
      if (!xs.length) xs = [cl.l != null && cl.r != null ? (cL + cR - mw) / 2 : cl.l != null ? cL + 1 : cR - 1 - mw];
      // prints in a row can sit at slightly different heights (Reeve's corrections: ±10px on a 700px frame)
      const vtol = Math.max(6, mh * 0.04), ys = [mt, (mt + mb - mh) / 2];
      if (Math.abs(q.t - mt) <= vtol) ys.push(q.t); if (Math.abs(q.b - mh - mt) <= vtol) ys.push(q.b - mh);
      let best = null, bv = -Infinity;
      for (const x of xs) for (const y of ys) {
        const cr = cand(x, y), y0 = cr.t + mh * .2, y1 = cr.b - mh * .2, x0 = cr.l + mw * .2, x1 = cr.r - mw * .2;
        const v = edgeScore(true, cr.l, -1, y0, y1) + edgeScore(true, cr.r - 1, 1, y0, y1) + edgeScore(false, cr.t, -1, x0, x1) + edgeScore(false, cr.b - 1, 1, x0, x1);
        if (v > bv) { bv = v; best = cr; }
      }
      // fine-tune position ±3px
      const b0 = best;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -6; dx <= 6; dx++) {
        const cr = cand(b0.l + dx, b0.t + dy), y0 = cr.t + mh * .2, y1 = cr.b - mh * .2, x0 = cr.l + mw * .2, x1 = cr.r - mw * .2;
        const v = edgeScore(true, cr.l, -1, y0, y1) + edgeScore(true, cr.r - 1, 1, y0, y1) + edgeScore(false, cr.t, -1, x0, x1) + edgeScore(false, cr.b - 1, 1, x0, x1);
        if (v > bv) { bv = v; best = cr; }
      }
      // each side may then settle within ±6px on its own (prints are only *nearly* the same size)
      {
        const y0 = best.t + mh * .2, y1 = best.b - mh * .2, x0 = best.l + mw * .2, x1 = best.r - mw * .2;
        // sides at the plate's outer border get more room: the plate edge often trims those frames
        const tune = (vert, pos, sign, a0, a1, R) => { let bp = pos, bs = edgeScore(vert, pos, sign, a0, a1); for (let k = -R; k <= R; k++) { const v = edgeScore(vert, pos + k, sign, a0, a1) - Math.abs(k) * 0.4 * 6 / R; if (v > bs) { bs = v; bp = pos + k; } } return bp; };
        const rw = Math.max(6, Math.round(mw * 0.02)), rh = Math.max(6, Math.round(mh * 0.02)), ow = Math.max(8, Math.round(mw * 0.1)), oh = Math.max(8, Math.round(mh * 0.1));
        best.l = Math.max(0, best.l); best.t = Math.max(0, best.t); best.r = Math.min(pl.W, best.r); best.b = Math.min(pl.H, best.b);
        // outer = the frame sits against the plate's border on that side (first/last in the row, top/bottom row)
        const oL = c === 0, oR = c === cells.length - 1, oT = cells[c][1] < pl.H * 0.03, oB = cells[c][3] > pl.H * 0.97;
        best = { l: tune(true, best.l, -1, y0, y1, oL ? ow : rw), r: tune(true, best.r - 1, 1, y0, y1, oR ? ow : rw) + 1,
                 t: tune(false, best.t, -1, x0, x1, rh), b: tune(false, best.b - 1, 1, x0, x1, rh) + 1 };
        best.l = Math.max(0, best.l); best.t = Math.max(0, best.t); best.r = Math.min(pl.W, best.r); best.b = Math.min(pl.H, best.b);
      }
      // interior grid lines are hard borders: a frame never takes pixels past them
      let clip = cl;
      if (clip.l != null) best.l = Math.max(best.l, clip.l + 1); if (clip.r != null) best.r = Math.min(best.r, clip.r - 1);
      if (clip.t != null) best.t = Math.max(best.t, clip.t + 1); if (clip.b != null) best.b = Math.min(best.b, clip.b - 1);
      const autoRect = { ...best };
      // a rectangle the user set by hand wins (and may reach past the grid line)
      const ov = rectFor(c);
      if (ov) {
        best = { ...ov }; const mg = Math.max(3, o.depth) + 1;
        clip = { l: clip.l != null ? Math.min(clip.l, best.l - mg) : null, r: clip.r != null ? Math.max(clip.r, best.r + mg) : null, t: clip.t != null ? Math.min(clip.t, best.t - mg) : null, b: clip.b != null ? Math.max(clip.b, best.b + mg) : null };
      }
      // grow the crop if the rectangle pokes past the cell + bleed
      const m = Math.max(3, o.depth) + 2, cell = cells[c];
      const need = Math.max(o.bleed, cell[0] - best.l + m, best.r - cell[2] + m, cell[1] - best.t + m, best.b - cell[3] + m);
      const cut = cutFrame(pl, tones, cell, { ...o, bleed: Math.ceil(need), rectFix: best, clip }, polysFor(c));
      cut.rowRect = best; cut.autoRect = autoRect; cut.manual = !!ov;
      return cut;
    });
  }

  // ---------- quadrilateral workflow ----------
  // From a rough box around the first frame of a row, guess every frame's corners in that row.
  // Returns [{quad:[[x,y]×4]}] (TL, TR, BR, BL), left to right.
  function guessRow(pl, tones, box, count) {
    const [bl, bt, br, bb] = box, bw = br - bl, bh = bb - bt;
    const y0 = Math.max(0, Math.round(bt - bh * 0.1)), y1 = Math.min(pl.H, Math.round(bb + bh * 0.1));
    let lines = detectCols(pl, tones, y0, y1);
    // start at the gutter line nearest the box's left side
    let i0 = 0; for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i] - bl) < Math.abs(lines[i0] - bl)) i0 = i;
    if (Math.abs(lines[i0] - bl) > bw * 0.35) { lines = [Math.max(0, Math.round(bl - bw * 0.05)), ...lines.filter(x => x > bl + bw * 0.5)]; i0 = 0; }
    let L = lines.slice(i0);
    // the box's own width is the best guide to the pitch; keep cells that look like frames
    const pitch0 = L.length > 1 ? L[1] - L[0] : bw * 1.05;
    const out = [L[0]];
    for (let k = 1; k < L.length; k++) { const w = L[k] - out[out.length - 1]; if (w > pitch0 * 0.6) out.push(L[k]); }
    L = out;
    // drop a trailing sliver (plate margin)
    while (L.length > 2 && (L[L.length - 1] - L[L.length - 2]) < pitch0 * 0.6) L.pop();
    const pitch = L.length > 2 ? (L[L.length - 1] - L[0]) / (L.length - 1) : pitch0;
    const want = count || Math.max(1, L.length - 1);
    while (L.length - 1 < want) L.push(Math.min(pl.W + pitch, Math.round(L[L.length - 1] + pitch)));
    L = L.slice(0, want + 1);
    const cells = L.slice(0, -1).map((x, k) => [Math.max(0, x), y0, Math.min(pl.W, L[k + 1]), y1]);
    const cuts = cutRow(pl, tones, cells, { bleed: 20, tol: 12, soft: 1, depth: 5, smooth: 5, keepSpecks: false, speckMax: 0 }, () => null);
    return cuts.map(k => { const r = k.rowRect; return { quad: [[r.l, r.t], [r.r, r.t], [r.r, r.b], [r.l, r.b]] }; });
  }
  // Natural number of frames to the right of a box (for the count shown in step 1).
  function countRow(pl, tones, box) { return guessRow(pl, tones, box).length; }

  // Snap each corner of a quad onto the print: near the corner, trace the two print edges that meet there
  // (strongest tone step across each edge, sub-pixel) and put the corner where those lines cross.
  // Corners whose edges are too faint to trace stay where they were. Moves are capped at `reach` px.
  function snapQuad(pl, quad, o = {}) {
    const W = pl.W, H = pl.H, L = pl.L;
    const at = (x, y) => { if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return NaN; const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
      return L[i] * (1 - fx) * (1 - fy) + L[i + 1] * fx * (1 - fy) + L[i + W] * (1 - fx) * fy + L[i + W + 1] * fx * fy; };
    const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4;
    // fit the edge from corner P toward Q: returns a line {p, u} or null
    const traceEdge = (P, Q) => {
      const dx = Q[0] - P[0], dy = Q[1] - P[1], len = Math.hypot(dx, dy); if (len < 20) return null;
      const u = [dx / len, dy / len]; let nrm = [-u[1], u[0]];
      const mx = (P[0] + Q[0]) / 2, my = (P[1] + Q[1]) / 2; if ((mx - cx) * nrm[0] + (my - cy) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]]; // outward
      const S = Math.max(4, Math.round(len * 0.015)), t0 = Math.max(4, len * 0.02), t1 = Math.max(t0 + 12, len * 0.18), pts = [];
      for (let t = t0; t <= t1; t += 1) {
        const bx = P[0] + u[0] * t, by = P[1] + u[1] * t, prof = [];
        for (let s = -S - 2; s <= S + 2; s++) {
          // average 3 samples along the edge to calm noise
          let v = 0; for (const e of [-1, 0, 1]) v += at(bx + nrm[0] * s + u[0] * e, by + nrm[1] * s + u[1] * e); prof.push(v / 3);
        }
        if (prof.some(Number.isNaN)) continue;
        // the print edge is the outermost clear step (first one met coming in from the gutter), not just the strongest:
        // the strongest is often an edge inside the photo
        const G = []; let gmax = 0;
        for (let i = 2; i < prof.length - 2; i++) { G[i] = Math.abs((prof[i + 1] + prof[i + 2]) - (prof[i - 1] + prof[i - 2])) / 2; gmax = Math.max(gmax, G[i]); }
        const thr = Math.max(o.minStep || 4, gmax * 0.5);
        // and it must be a real print edge: gutter-toned outside, not gutter-toned inside
        // (rejects a neighbour print's edge across a narrow gutter, and steps inside the mount)
        const gt = o.gutter, mean = (a, b) => { let v = 0, c = 0; for (let j = Math.max(0, a); j <= Math.min(prof.length - 1, b); j++) { v += prof[j]; c++; } return v / c; };
        let best = -1, bg = 0;
        for (let i = prof.length - 3; i >= 2; i--) {
          if (!(G[i] >= thr && G[i] >= (G[i - 1] || 0) && G[i] >= (G[i + 1] || 0))) continue;
          if (gt != null) { const out = mean(i + 2, i + 4), inn = mean(i - 4, i - 2);
            if (Math.abs(out - gt) > 18 || Math.abs(inn - gt) < 8) continue; }
          best = i; bg = G[i]; break;
        }
        if (best < 3 || best > prof.length - 4) continue;
        const g = i => Math.abs((prof[i + 1] + prof[i + 2]) - (prof[i - 1] + prof[i - 2])) / 2, a = g(best - 1), c = g(best + 1), den = a - 2 * bg + c;
        const sub = den < 0 ? 0.5 * (a - c) / den : 0;
        pts.push([t, best - S - 2 + sub, bg]);
      }
      if (pts.length < 8) return null;
      // weighted line fit s = a + b t, then refit without outliers
      const fit = ps => { let sw = 0, st = 0, ss = 0, stt = 0, sts = 0; for (const [t, sv, w] of ps) { sw += w; st += w * t; ss += w * sv; stt += w * t * t; sts += w * t * sv; }
        const den = sw * stt - st * st; const b = den ? (sw * sts - st * ss) / den : 0; return [(ss - b * st) / sw, b]; };
      let [a, b] = fit(pts);
      const keep = pts.filter(([t, sv]) => Math.abs(sv - (a + b * t)) <= 1.5);
      if (keep.length < 8) return null;
      [a, b] = fit(keep);
      if (Math.abs(b) > 0.06) return null; // a print edge is nearly straight along the guess; steep = not an edge
      // line through P + n·a with direction u + n·b
      const p = [P[0] + nrm[0] * a, P[1] + nrm[1] * a], dir = [u[0] + nrm[0] * b, u[1] + nrm[1] * b];
      return { p, u: dir };
    };
    const reach = o.reach || 10, traced = [];
    const out = quad.map((P, k) => {
      const A = quad[(k + 1) % 4], B = quad[(k + 3) % 4];
      const e1 = traceEdge(P, A), e2 = traceEdge(P, B);
      // lines: an untraced edge keeps the quad's own edge
      const l1 = e1 || { p: P, u: [A[0] - P[0], A[1] - P[1]] }, l2 = e2 || { p: P, u: [B[0] - P[0], B[1] - P[1]] };
      traced[k] = false;
      if (!e1 || !e2) { if (!e1 && !e2) return P.slice(); }
      const den = l1.u[0] * l2.u[1] - l1.u[1] * l2.u[0]; if (Math.abs(den) < 1e-6) return P.slice();
      const t = ((l2.p[0] - l1.p[0]) * l2.u[1] - (l2.p[1] - l1.p[1]) * l2.u[0]) / den;
      const X = l1.p[0] + l1.u[0] * t, Y = l1.p[1] + l1.u[1] * t;
      if (Math.hypot(X - P[0], Y - P[1]) > reach) return P.slice();
      traced[k] = !!(e1 && e2);   // both edges found: this corner really sits where the print's edges cross
      return [Math.round(X * 4) / 4, Math.round(Y * 4) / 4];
    });
    out.traced = traced;
    return out;
  }

  // Cut one frame along a user quadrilateral (plate coords, TL TR BR BL).
  // o.exact: alpha is just the quad (1px antialiased). Otherwise the real print edge is found, but never more
  // than o.tol px outside or inside the quad.
  function cutQuad(pl, tones, quad, o) {
    const T = Math.max(0, o.tol | 0), mg = T + 4;
    let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
    for (const [x, y] of quad) { qx0 = Math.min(qx0, x); qy0 = Math.min(qy0, y); qx1 = Math.max(qx1, x); qy1 = Math.max(qy1, y); }
    const X0 = Math.max(0, Math.floor(qx0 - mg)), Y0 = Math.max(0, Math.floor(qy0 - mg)), X1 = Math.min(pl.W, Math.ceil(qx1 + mg)), Y1 = Math.min(pl.H, Math.ceil(qy1 + mg));
    const w = X1 - X0, h = Y1 - Y0, n = w * h;
    // signed distance to the (convex) quad, positive outside
    const q = quad.map(([x, y]) => [x - X0, y - Y0]);
    let area = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
    const sgn = area > 0 ? 1 : -1, edges = [];
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1; edges.push([a[0], a[1], sgn * dy / len, -sgn * dx / len]); }
    const sd = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = -Infinity; const px = x + .5, py = y + .5;
      for (const [ax, ay, nx, ny] of edges) { const v = (px - ax) * nx + (py - ay) * ny; if (v > m) m = v; }
      sd[y * w + x] = m;
    }
    const alpha = new Uint8Array(n);
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const res = { x: X0, y: Y0, w, h, alpha, center: [cx, cy], quad: q, gutterRGB: [tones.gutter, tones.gutter, tones.gutter] };
    if (o.exact || T === 0) {
      for (let i = 0; i < n; i++) alpha[i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - sd[i])));
      return res;
    }
    const l = new Float32Array(n), s = new Float32Array(n);
    for (let y = 0; y < h; y++) { const src = (Y0 + y) * pl.W + X0; l.set(pl.L.subarray(src, src + w), y * w); s.set(pl.S.subarray(src, src + w), y * w); }
    // background tones: plate gutter/paper plus whatever surrounds this frame just outside the band
    const ring = []; for (let i = 0; i < n; i++) if (sd[i] > T && s[i] < 4) ring.push(l[i]);
    const tonesArr = [tones.gutter]; if (tones.paper != null) tonesArr.push(tones.paper);
    if (ring.length > 20) { ring.sort((a, b) => a - b); tonesArr.push(ring[ring.length >> 1]); }
    const tol = 12, sT = 5, d = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 1e9; for (const t of tonesArr) { const v = Math.abs(l[i] - t); if (v < m) m = v; } d[i] = m; }
    let pass = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = sd[i];
      pass[i] = v > T ? 1 : v <= -T ? 0 : (s[i] < sT && d[i] < (v > 0 ? tol : 3.5)) ? 1 : 0;
    }
    const opened = dilate(erode(pass, w, h), w, h);
    for (let i = 0; i < n; i++) pass[i] = (opened[i] || (pass[i] && sd[i] > 0)) && sd[i] > -T ? 1 : 0;
    const F = new Uint8Array(n), qq = new Int32Array(n); let qh = 0, qt = 0;
    const seed = i => { if (pass[i] && !F[i]) { F[i] = 1; qq[qt++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (qh < qt) { const i = qq[qh++], x = i % w, y = (i - x) / w; if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (y > 0) seed(i - w); if (y < h - 1) seed(i + w); }
    const band = dilate(dilate(F, w, h), w, h);
    for (let i = 0; i < n; i++) {
      if (F[i]) alpha[i] = 0;
      else if (band[i] && sd[i] > -T) alpha[i] = Math.round(255 * Math.min(1, Math.max(0, (d[i] - tol * 0.4) / (tol * 1.6))));
      else alpha[i] = 255;
    }
    // keep only the main piece
    const lab = new Int32Array(n); let best = 0, bestN = 0, nl = 0;
    for (let i = 0; i < n; i++) {
      if (!alpha[i] || lab[i]) continue; nl++; let size = 0; lab[i] = nl; qq[0] = i; qh = 0; qt = 1;
      while (qh < qt) { const j = qq[qh++], x = j % w, y = (j - x) / w; size++;
        if (x > 0 && alpha[j - 1] && !lab[j - 1]) { lab[j - 1] = nl; qq[qt++] = j - 1; } if (x < w - 1 && alpha[j + 1] && !lab[j + 1]) { lab[j + 1] = nl; qq[qt++] = j + 1; }
        if (y > 0 && alpha[j - w] && !lab[j - w]) { lab[j - w] = nl; qq[qt++] = j - w; } if (y < h - 1 && alpha[j + w] && !lab[j + w]) { lab[j + w] = nl; qq[qt++] = j + w; } }
      if (size > bestN) { bestN = size; best = nl; }
    }
    for (let i = 0; i < n; i++) if (alpha[i] && lab[i] !== best) alpha[i] = 0;
    return res;
  }

  function erode(m, w, h) {
    const o = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!m[i]) continue; let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; if (!m[yy * w + xx]) { ok = 0; break; } }
      o[i] = ok;
    }
    return o;
  }
  function dilate(m, w, h) {
    const o = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (m[i]) { o[i] = 1; continue; }
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; if (m[yy * w + xx]) { hit = 1; break; } }
      o[i] = hit;
    }
    return o;
  }
  function fillPoly(mask, w, h, poly) {
    if (poly.length < 3) return;
    let y0 = Infinity, y1 = -Infinity; for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(h - 1, Math.ceil(y1));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = a; x <= b; x++) mask[y * w + x] = 1;
      }
    }
  }

  // RGBA ImageData for a cut frame
  function renderCut(pl, cut, defringe) {
    const { x: X0, y: Y0, w, h, alpha, gutterRGB: G } = cut;
    const out = new ImageData(w, h), od = out.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, p = ((Y0 + y) * pl.W + X0 + x) * 4, o = i * 4, a = alpha[i];
      let r = pl.rgba[p], g = pl.rgba[p + 1], b = pl.rgba[p + 2];
      if (defringe && a > 0 && a < 255) {
        const af = Math.max(0.2, a / 255);
        r = (r - (1 - af) * G[0]) / af; g = (g - (1 - af) * G[1]) / af; b = (b - (1 - af) * G[2]) / af;
      }
      od[o] = r; od[o + 1] = g; od[o + 2] = b; od[o + 3] = a;
    }
    return out;
  }

  // ---------- alignment (translation only) ----------
  // Find d so that B(x) ≈ A(x + d) near guess d0. Pixels that disagree most after a first match
  // (the moving figure) are dropped and the match is redone, so it settles on the floor, walls and props.
  // opts.box = [x0,y0,x1,y1] in A's crop coords: only match on that patch (an anchor the user drew).
  function matchShift(pl, A, B, d0, range, opts = {}) {
    const lum = (c) => { const a = new Float32Array(c.w * c.h); for (let y = 0; y < c.h; y++) a.set(pl.L.subarray((c.y + y) * pl.W + c.x, (c.y + y) * pl.W + c.x + c.w), y * c.w); return a; };
    const blur = (img, w, h, r) => {
      const t = new Float32Array(img.length), o2 = new Float32Array(img.length);
      for (let y = 0; y < h; y++) { let s = 0, c = 0; const row = y * w;
        for (let x = -r; x < w; x++) { if (x + r < w) { s += img[row + x + r]; c++; } if (x - r - 1 >= 0) { s -= img[row + x - r - 1]; c--; } if (x >= 0) t[row + x] = s / c; } }
      for (let x = 0; x < w; x++) { let s = 0, c = 0;
        for (let y = -r; y < h; y++) { if (y + r < h) { s += t[(y + r) * w + x]; c++; } if (y - r - 1 >= 0) { s -= t[(y - r - 1) * w + x]; c--; } if (y >= 0) o2[y * w + x] = s / c; } }
      return o2;
    };
    // blur: fine backdrop grids would otherwise lock onto the wrong line
    const prep = K => { const im = lum(K); return blur(blur(im, K.w, K.h, 3), K.w, K.h, 3); };
    const mk = (K, img) => ({ img, msk: K.alpha, w: K.w, h: K.h, ex: new Uint8Array(K.w * K.h) });
    const fa = mk(A, prep(A)), fb = mk(B, prep(B));
    const box = opts.box;
    const down = (F, f) => {
      const W = Math.floor(F.w / f), H = Math.floor(F.h / f), o = { img: new Float32Array(W * H), msk: new Uint8Array(W * H), ex: new Uint8Array(W * H), w: W, h: H };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, ok = 1, ex = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) { const k = (y * f + j) * F.w + x * f + i; s += F.img[k]; if (F.msk[k] < 250) ok = 0; if (F.ex[k]) ex = 1; }
        o.img[y * W + x] = s / (f * f); o.msk[y * W + x] = ok ? 255 : 0; o.ex[y * W + x] = ex;
      }
      return o;
    };
    // stats over the overlap; f = scale of a/b relative to crop px (for the anchor box test)
    const ncc = (a, b, dx, dy, step, f) => {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = 0; y < b.h; y += step) {
        const ay = y + dy; if (ay < 0 || ay >= a.h) continue;
        if (box && (ay * f < box[1] || ay * f >= box[3])) continue;
        for (let x = 0; x < b.w; x += step) {
          const ax = x + dx; if (ax < 0 || ax >= a.w) continue;
          if (box && (ax * f < box[0] || ax * f >= box[2])) continue;
          const ib = y * b.w + x, ia = ay * a.w + ax;
          if (b.msk[ib] < 250 || a.msk[ia] < 250 || b.ex[ib]) continue;
          const va = a.img[ia], vb = b.img[ib];
          n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      if (n < 150 / (step * step * f * f) + 12) return { v: -2, n };
      const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      return { v: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -2, n };
    };
    const f = range <= 16 ? 2 : 4, RX = range, RY = range;
    const search = (center, rx, ry) => {
      const ca = down(fa, f), cb = down(fb, f);
      let best = [Math.round(center[0]), Math.round(center[1])], bv = -3;
      const gx = Math.round(center[0] / f), gy = Math.round(center[1] / f), R = Math.ceil(rx / f), Ry = Math.ceil(ry / f);
      for (let dy = gy - Ry; dy <= gy + Ry; dy++) for (let dx = gx - R; dx <= gx + R; dx++) {
        const r = ncc(ca, cb, dx, dy, 1, f); if (r.v > bv) { bv = r.v; best = [dx * f, dy * f]; }
      }
      const c = best.slice(); bv = -3; let nn = 0;
      for (let dy = c[1] - f; dy <= c[1] + f; dy++) for (let dx = c[0] - f; dx <= c[0] + f; dx++) {
        const r = ncc(fa, fb, dx, dy, 2, 1); if (r.v > bv) { bv = r.v; best = [dx, dy]; nn = r.n; }
      }
      return { d: best, score: bv, n: nn };
    };
    let res = search(d0, RX, RY);
    if (opts.robust !== false && !box) {
      for (let pass = 0; pass < 2; pass++) {
        // residual after a gain/offset fit; drop the worst 35% (what moved) and re-match nearby
        const [dx, dy] = res.d, pairs = [];
        let sa = 0, sb = 0, saa = 0, sab = 0, n = 0;
        for (let y = 0; y < fb.h; y += 2) { const ay = y + dy; if (ay < 0 || ay >= fa.h) continue;
          for (let x = 0; x < fb.w; x += 2) { const ax = x + dx; if (ax < 0 || ax >= fa.w) continue;
            const ib = y * fb.w + x, ia = ay * fa.w + ax; if (fb.msk[ib] < 250 || fa.msk[ia] < 250) continue;
            const va = fa.img[ia], vb = fb.img[ib]; sa += va; sb += vb; saa += va * va; sab += va * vb; n++; pairs.push(ib, va, vb); } }
        if (n < 100) break;
        const g = (sab - sa * sb / n) / Math.max(1e-6, saa - sa * sa / n), off = (sb - g * sa) / n;
        const errs = []; for (let i = 0; i < pairs.length; i += 3) errs.push(Math.abs(pairs[i + 2] - (g * pairs[i + 1] + off)));
        const cut = errs.slice().sort((x, y) => x - y)[Math.floor(errs.length * 0.65)];
        fb.ex.fill(0);
        for (let i = 0, k = 0; i < pairs.length; i += 3, k++) if (errs[k] > cut) { const ib = pairs[i], x = ib % fb.w, y = (ib - x) / fb.w;
          for (let yy = Math.max(0, y - 4); yy < Math.min(fb.h, y + 5); yy++) for (let xx = Math.max(0, x - 4); xx < Math.min(fb.w, x + 5); xx++) fb.ex[yy * fb.w + xx] = 1; }
        res = search(res.d, Math.max(4, RX / 2), Math.max(4, RY / 2));
      }
    }
    return res;
  }

  // ---------- zip (store only) ----------
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function makeZip(files) { // files: [{name, data:Uint8Array}]
    const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF, dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + size;
    }
    let csize = 0; for (const c of central) csize += c.length;
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  return { preparePlate, estimateTones, detectGrid, detectCols, cutFrame, cutRow, guessRow, countRow, cutQuad, snapQuad, renderCut, matchShift, makeZip, fillPoly };
})();
if (typeof module !== 'undefined') module.exports = Core;
