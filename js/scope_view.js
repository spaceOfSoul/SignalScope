/* scope_view.js — 오실로스코프 화면 렌더링 (Canvas, requestAnimationFrame 주기 — 시뮬레이션과 독립)
 *  - 10 × 8 division 그래티큘, CH1(노랑)/CH2(청록)
 *  - 저장된 레코드를 현재 수평/수직 설정으로 매핑하여 표시 (Stop/Zoom 시 원본 데이터 유지)
 *  - 픽셀 열 단위 min/max 데시메이션 → 짧은 펄스도 화면에서 사라지지 않음
 *  - 마커: 채널 GND 기준, 트리거 레벨, 트리거 위치, Zoom 영역
 *  - 마우스: 휠 = Zoom, 드래그 = 수평 위치/Zoom 위치, 우측 T 마커 드래그 = 트리거 레벨, 좌측 마커 드래그 = 채널 위치
 */
(function (G) {
  'use strict';
  const VS = G.VS, U = VS.util;
  const CH_COL = ['#ffd400', '#1fd6e8'];
  const TRIG_COL = '#ff9a3c';
  const ZOOM_STEPS = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];

  class ScopeView {
    constructor(canvas, sim, app) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.sim = sim; this.app = app;
      this.dpr = 1; this.W = 0; this.H = 0;
      this.pathCache = new Map();
      this.levelFlash = 0;
      this.measCache = { key: '', res: [null, null] };
      this.drag = null;
      this.hover = null;
      this._bindMouse();
    }
    get scope() { return this.sim.scope; }
    resize() {
      const r = this.cv.getBoundingClientRect();
      const dpr = Math.min(2, G.devicePixelRatio || 1);
      const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
      if (w !== this.cv.width || h !== this.cv.height) { this.cv.width = w; this.cv.height = h; this.pathCache.clear(); }
      this.dpr = dpr; this.W = r.width; this.H = r.height;
    }
    flashLevel() { this.levelFlash = performance.now() + 1500; }

    // ---------------- 레이아웃 ----------------
    layout() {
      const s = this.scope.s, W = this.W, H = this.H;
      const nMeas = s.display.measure ? (s.ch[0].on ? 1 : 0) + (s.ch[1].on ? 1 : 0) : 0;
      const top = 24, bottom = 24 + nMeas * 17 + 4;
      const ax = 10, ay = top + 4, aw = W - 20, ah = H - top - bottom - 8;
      const L = { top: top, bottom: bottom, panels: [] };
      const rec = this.scope.record;
      const main = this.scope.mainWindow(rec);
      if (s.zoom.on) {
        const oh = Math.max(60, Math.round(ah * 0.27));
        L.panels.push({ kind: 'over', x: ax, y: ay, w: aw, h: oh, win: main });
        L.panels.push({ kind: 'zoom', x: ax, y: ay + oh + 8, w: aw, h: ah - oh - 8, win: this.scope.zoomWindow(rec) });
      } else {
        const div = Math.max(8, Math.min(aw / 10, ah / 8));
        const pw = div * 10, ph = div * 8;
        L.panels.push({ kind: 'main', x: ax + (aw - pw) / 2, y: ay + (ah - ph) / 2, w: pw, h: ph, win: main });
      }
      return L;
    }

    // ---------------- 렌더 ----------------
    render() {
      this.resize();
      const ctx = this.ctx, dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#050607'; ctx.fillRect(0, 0, this.W, this.H);
      if (this.W < 50 || this.H < 50) return;
      if (this.scope.isXY()) { this._renderXY(); return; }     // XY 모드 (scope_view_xy.js)
      const L = this.layout(); this.L = L;
      const rec = this.scope.record;
      for (const p of L.panels) {
        this._grid(p);
        ctx.save();
        ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
        if (rec) for (let c = 1; c >= 0; c--) if (this.scope.s.ch[c].on && rec.ch[c]) this._trace(p, rec, c);
        if (p.kind === 'over') this._zoomBox(p, rec);
        this._levelLine(p);
        ctx.restore();
        this._markers(p, rec);
      }
      this._topBar(L, rec);
      this._bottomBar(L, rec);
    }

    _grid(p) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(150,160,175,0.55)'; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, Math.round(p.w), Math.round(p.h));
      const dx = p.w / 10, dy = p.h / 8;
      ctx.strokeStyle = 'rgba(140,150,165,0.28)';
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      for (let i = 1; i < 10; i++) { const x = Math.round(p.x + i * dx) + 0.5; ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); }
      for (let j = 1; j < 8; j++) { const y = Math.round(p.y + j * dy) + 0.5; ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); }
      ctx.stroke();
      ctx.setLineDash([]);
      // 중심축 눈금 (0.2 div)
      ctx.strokeStyle = 'rgba(160,170,185,0.5)';
      ctx.beginPath();
      const cx = Math.round(p.x + p.w / 2) + 0.5, cy = Math.round(p.y + p.h / 2) + 0.5;
      for (let i = 0; i <= 50; i++) { const x = Math.round(p.x + i * dx / 5) + 0.5, t = i % 5 === 0 ? 5 : 3; ctx.moveTo(x, cy - t); ctx.lineTo(x, cy + t); }
      for (let j = 0; j <= 40; j++) { const y = Math.round(p.y + j * dy / 5) + 0.5, t = j % 5 === 0 ? 5 : 3; ctx.moveTo(cx - t, y); ctx.lineTo(cx + t, y); }
      ctx.stroke();
      ctx.restore();
    }

    /** 트레이스 Path2D (캐시) */
    _path(p, rec, c) {
      const s = this.scope.s, cs = s.ch[c], info = rec.ch[c];
      const key = [rec.id, c, p.kind, p.x, p.y, p.w, p.h, p.win.L, p.win.R, cs.vdiv, cs.pos, s.display.vectors].join('|');
      const hit = this.pathCache.get(key);
      if (hit) return hit;
      const path = new Path2D();
      const yc = p.y + p.h / 2, dpy = p.h / 8, vd = cs.vdiv, pos = cs.pos;
      const toY = (v) => yc - (v / vd + pos) * dpy;
      const tL = rec.tRef + p.win.L, span = p.win.R - p.win.L, pps = p.w / span;
      const n = rec.n, dt = rec.dt;
      const i0 = Math.max(0, Math.floor((tL - rec.t0) / dt) - 1);
      const i1 = Math.min(n - 1, Math.ceil((tL + span - rec.t0) / dt) + 1);
      const data = info.data, mn = info.min, mx = info.max;
      const dots = !s.display.vectors;
      if (i1 >= i0) {
        const nVis = i1 - i0 + 1;
        if (nVis < p.w * 0.7) {
          // 희소: 샘플 사이 벡터(선형) 또는 도트
          let pen = false;
          for (let i = i0; i <= i1; i++) {
            const x = p.x + (rec.t0 + i * dt - tL) * pps;
            if (data) {
              const v = data[i];
              if (v !== v) { pen = false; continue; }
              const y = toY(v);
              if (dots) { path.rect(x - 1, y - 1, 2, 2); continue; }
              if (!pen) { path.moveTo(x, y); pen = true; } else path.lineTo(x, y);
            } else {
              const a = mn[i], b = mx[i];
              if (a !== a) { pen = false; continue; }
              path.moveTo(x, toY(a)); path.lineTo(x, toY(b) - 0.01);
              if (!dots && i < i1 && mn[i + 1] === mn[i + 1]) {
                const x2 = p.x + (rec.t0 + (i + 1) * dt - tL) * pps;
                path.moveTo(x, toY(a)); path.lineTo(x2, toY(mn[i + 1]));
                path.moveTo(x, toY(b)); path.lineTo(x2, toY(mx[i + 1]));
              }
            }
          }
        } else {
          // 조밀: 픽셀 열 단위 min/max 포락선 (짧은 펄스 보존)
          const cols = Math.ceil(p.w) + 1;
          const cmn = new Float32Array(cols).fill(Infinity), cmx = new Float32Array(cols).fill(-Infinity);
          for (let i = i0; i <= i1; i++) {
            let col = Math.floor((rec.t0 + i * dt - tL) * pps);
            if (col < 0 || col >= cols) continue;
            const a = data ? data[i] : mn[i], b = data ? data[i] : mx[i];
            if (a !== a) continue;
            if (a < cmn[col]) cmn[col] = a;
            if (b > cmx[col]) cmx[col] = b;
          }
          let prevLo = NaN, prevHi = NaN;
          for (let col = 0; col < cols; col++) {
            if (cmn[col] === Infinity) { prevLo = prevHi = NaN; continue; }
            let lo = cmn[col], hi = cmx[col];
            // 이전 열과 연결 (벡터 연속성)
            if (!dots && prevLo === prevLo) { if (prevHi < lo) lo = prevHi; if (prevLo > hi) hi = prevLo; }
            const x = p.x + col + 0.5;
            const y1 = toY(hi), y2 = toY(lo);
            path.moveTo(x, y1); path.lineTo(x, Math.max(y2, y1 + 0.8));
            prevLo = cmn[col]; prevHi = cmx[col];
          }
        }
      }
      if (this.pathCache.size > 64) this.pathCache.clear();
      this.pathCache.set(key, path);
      return path;
    }
    _trace(p, rec, c) {
      const ctx = this.ctx;
      ctx.strokeStyle = CH_COL[c]; ctx.fillStyle = CH_COL[c];
      ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
      ctx.shadowColor = CH_COL[c]; ctx.shadowBlur = 3;
      const path = this._path(p, rec, c);
      if (!this.scope.s.display.vectors) ctx.fill(path);
      ctx.stroke(path);
      ctx.shadowBlur = 0;
    }
    _zoomBox(p, rec) {
      const ctx = this.ctx, z = this.scope.zoomWindow(rec), m = p.win;
      const x1 = p.x + (z.L - m.L) / (m.R - m.L) * p.w, x2 = p.x + (z.R - m.L) / (m.R - m.L) * p.w;
      ctx.fillStyle = 'rgba(78,161,255,0.13)'; ctx.fillRect(x1, p.y, Math.max(1, x2 - x1), p.h);
      ctx.strokeStyle = 'rgba(120,180,255,0.9)'; ctx.lineWidth = 1;
      ctx.strokeRect(x1 + 0.5, p.y + 0.5, Math.max(1, x2 - x1 - 1), p.h - 1);
    }
    _levelY(p) {
      const s = this.scope.s, cs = s.ch[s.trig.source];
      return p.y + p.h / 2 - (s.trig.level / cs.vdiv + cs.pos) * p.h / 8;
    }
    _levelLine(p) {
      if (performance.now() > this.levelFlash && !(this.drag && this.drag.kind === 'level')) return;
      const ctx = this.ctx, y = this._levelY(p);
      ctx.strokeStyle = CH_COL[this.scope.s.trig.source]; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke(); ctx.setLineDash([]);
    }
    _pennant(x, y, dir, color, text, clampTop, clampBot) {
      // dir: +1 = 오른쪽을 가리킴 (좌측 마커), -1 = 왼쪽을 가리킴 (우측 마커)
      const ctx = this.ctx;
      let arrow = 0;
      if (y < clampTop) { y = clampTop; arrow = -1; } else if (y > clampBot) { y = clampBot; arrow = 1; }
      ctx.fillStyle = color;
      ctx.beginPath();
      if (dir > 0) { ctx.moveTo(x - 16, y - 7); ctx.lineTo(x - 5, y - 7); ctx.lineTo(x, y); ctx.lineTo(x - 5, y + 7); ctx.lineTo(x - 16, y + 7); }
      else { ctx.moveTo(x + 16, y - 7); ctx.lineTo(x + 5, y - 7); ctx.lineTo(x, y); ctx.lineTo(x + 5, y + 7); ctx.lineTo(x + 16, y + 7); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = 'bold 10px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(arrow ? (arrow < 0 ? '▲' : '▼') : text, dir > 0 ? x - 9.5 : x + 9.5, y + 0.5);
    }
    _markers(p, rec) {
      const s = this.scope.s, ctx = this.ctx;
      if (p.kind === 'over' && this.L.panels.length > 1) { /* 오버뷰에도 동일 마커 */ }
      // 채널 GND 기준
      for (let c = 0; c < 2; c++) {
        if (!s.ch[c].on) continue;
        const y = p.y + p.h / 2 - s.ch[c].pos * p.h / 8;
        this._pennant(p.x, y, 1, CH_COL[c], String(c + 1), p.y + 7, p.y + p.h - 7);
      }
      // 트리거 레벨
      if (!(rec && rec.kind === 'roll') && !this.scope.isRoll()) {
        const y = this._levelY(p);
        this._pennant(p.x + p.w, y, -1, CH_COL[s.trig.source], 'T', p.y + 7, p.y + p.h - 7);
        // 트리거 위치 (시간 0)
        const m = p.win;
        let x = p.x + (0 - m.L) / (m.R - m.L) * p.w, off = 0;
        if (x < p.x) { x = p.x + 6; off = -1; } else if (x > p.x + p.w) { x = p.x + p.w - 6; off = 1; }
        ctx.fillStyle = TRIG_COL;
        ctx.beginPath();
        if (off === 0) { ctx.moveTo(x - 6, p.y - 9); ctx.lineTo(x + 6, p.y - 9); ctx.lineTo(x, p.y - 1); }
        else if (off < 0) { ctx.moveTo(x - 6, p.y - 5); ctx.lineTo(x + 3, p.y - 10); ctx.lineTo(x + 3, p.y); }
        else { ctx.moveTo(x + 6, p.y - 5); ctx.lineTo(x - 3, p.y - 10); ctx.lineTo(x - 3, p.y); }
        ctx.closePath(); ctx.fill();
        if (p.kind !== 'over') {
          ctx.strokeStyle = 'rgba(255,154,60,0.35)'; ctx.setLineDash([2, 4]);
          if (off === 0) { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, p.y); ctx.lineTo(Math.round(x) + 0.5, p.y + p.h); ctx.stroke(); }
          ctx.setLineDash([]);
        }
      }
      // 패널 라벨
      if (p.kind !== 'main') {
        ctx.fillStyle = 'rgba(170,180,195,0.8)'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const tdiv = (p.win.R - p.win.L) / 10;
        ctx.fillText((p.kind === 'over' ? 'MAIN ' : 'ZOOM ') + U.fmtEng(tdiv, 's') + '/div', p.x + 20, p.y + 3);
      }
    }

    _badge(x, y, text, bg, fg) {
      const ctx = this.ctx;
      ctx.font = 'bold 11px Consolas, monospace';
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = bg; ctx.fillRect(x, y, w, 17);
      ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 6, y + 9);
      return x + w + 6;
    }
    _text(x, y, text, color, bold) {
      const ctx = this.ctx;
      ctx.font = (bold ? 'bold ' : '') + '11.5px Consolas, monospace';
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
      return x + ctx.measureText(text).width + 12;
    }
    _topBar(L, rec) {
      const sc = this.scope, s = sc.s, sim = this.sim;
      const y = 4;
      let x = 8;
      x = sc.running ? this._badge(x, y, 'RUN', '#1d7a40', '#d8ffe6') : this._badge(x, y, 'STOP', '#a32222', '#ffe0e0');
      const st = sc.running ? sc.status : 'Stop';
      const stCol = { "Trig'd": ['#174d2b', '#9dffbf'], Auto: ['#6b4a12', '#ffd99a'], Ready: ['#4d4a14', '#fff2a0'], Armed: ['#3c3f46', '#d0d6df'], Roll: ['#24476e', '#cfe4ff'], Stop: ['#3c3f46', '#ffb0b0'] }[st] || ['#3c3f46', '#ddd'];
      x = this._badge(x, y, st, stCol[0], stCol[1]);
      const H = sc.horiz();
      x = this._text(x, y + 9, 'H ' + U.fmtEng(s.tdiv, 's') + '/div', '#ffffff', true);
      if (s.zoom.on) x = this._text(x, y + 9, 'Z ' + U.fmtEng(s.tdiv / s.zoom.factor, 's') + ' ×' + s.zoom.factor, '#9cc8ff', true);
      x = this._text(x, y + 9, 'Pos ' + U.fmtEng(s.delay, 's', 4), '#c9d2de');
      x = this._text(x, y + 9, U.fmtEng(H.fs, 'Sa/s') + '  ' + U.fmtEng(H.n, 'pts'), '#c9d2de');
      const am = s.acq.mode === 'sample' ? 'Sample' : s.acq.mode === 'peak' ? 'Peak Det' : ('Avg ' + (rec && rec.avgCount ? rec.avgCount : 0) + '/' + s.acq.avgN);
      x = this._text(x, y + 9, am, '#c9d2de');
      const ctx = this.ctx;
      ctx.textAlign = 'right'; ctx.font = '11.5px Consolas, monospace';
      ctx.fillStyle = sim.paused ? '#ffcf70' : '#9aa6b6';
      const sp = sim.speed === 'max' ? 'MAX' : sim.speed + 'X';
      ctx.fillText((sim.paused ? '⏸ PAUSED  ' : '') + 'sim ' + U.fmtSimTime(sim.simTime) + '  ' + sp + ' (' + (sim.actualSpeed >= 100 ? sim.actualSpeed.toFixed(0) : sim.actualSpeed.toFixed(2)) + 'x)', this.W - 8, y + 9);
    }
    _bottomBar(L, rec) {
      const s = this.scope.s, ctx = this.ctx, sim = this.sim;
      let y = this.H - L.bottom + 6;
      let x = 8;
      for (let c = 0; c < 2; c++) {
        const cs = s.ch[c];
        const col = cs.on ? CH_COL[c] : '#555c66';
        ctx.fillStyle = col; ctx.fillRect(x, y, 16, 16);
        ctx.fillStyle = '#000'; ctx.font = 'bold 11px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(c + 1), x + 8, y + 8.5);
        x += 20;
        const pin = sim.inputs[c].label;
        const txt = U.fmtEng(cs.vdiv, 'V', 3) + '/div ' + cs.coupling + ' ' + cs.probe + 'X ' + (pin === '—' ? '(no probe)' : pin);
        x = this._text(x, y + 8.5, txt, cs.on ? col : '#6c7480', true);
        x += 6;
      }
      const tr = s.trig;
      x = this._text(x, y + 8.5, 'T  CH' + (tr.source + 1) + ' ' + (tr.slope === 'rise' ? '↑' : '↓') + ' ' + U.fmtEng(tr.level, 'V', 4) + '  ' +
        tr.mode[0].toUpperCase() + tr.mode.slice(1) + '  Pre/Post ' + Math.round(tr.pos * 100) + '/' + (100 - Math.round(tr.pos * 100)) + '%', TRIG_COL, true);
      // 측정
      if (s.display.measure) {
        const res = this._measure(rec);
        y += 20;
        for (let c = 0; c < 2; c++) {
          if (!s.ch[c].on) continue;
          const m = res[c];
          let t;
          if (!m) t = 'CH' + (c + 1) + '  --';
          else {
            const f = (v, u) => (v === v ? U.fmtMeas(v, u) : '--');
            t = 'CH' + (c + 1) + '  Freq ' + f(m.freq, 'Hz') + '  Period ' + f(m.period, 's') + '  +Duty ' + (m.duty === m.duty ? m.duty.toFixed(1) + '%' : '--') +
              '  Vpp ' + f(m.vpp, 'V') + '  Vmax ' + f(m.vmax, 'V') + '  Vmin ' + f(m.vmin, 'V') + '  Vavg ' + f(m.vavg, 'V') + '  Vrms ' + f(m.vrms, 'V');
          }
          ctx.font = '11px Consolas, monospace'; ctx.fillStyle = CH_COL[c]; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(t, 8, y + 8);
          y += 17;
        }
      }
    }
    _measure(rec) {
      if (!rec) return [null, null];
      const s = this.scope.s;
      const win = s.zoom.on ? this.scope.zoomWindow(rec) : this.scope.mainWindow(rec);
      const key = [rec.id, win.L, win.R, s.ch[0].vdiv, s.ch[1].vdiv].join('|');
      const now = performance.now();
      if (this.measCache.key === key) return this.measCache.res;
      if (rec.kind === 'roll' && now - (this.measCache.t || 0) < 250 && this.measCache.res) return this.measCache.res;
      const res = [VS.scopeMeasure(rec, 0, win.L, win.R), VS.scopeMeasure(rec, 1, win.L, win.R)];
      this.measCache = { key: key, res: res, t: now };
      return res;
    }

    // ---------------- 마우스 ----------------
    _panelAt(x, y) {
      if (!this.L) return null;
      for (const p of this.L.panels) if (x >= p.x - 18 && x <= p.x + p.w + 18 && y >= p.y - 10 && y <= p.y + p.h + 4) return p;
      return null;
    }
    _bindMouse() {
      const cv = this.cv;
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (this.scope.isXY()) { this._xyWheel(x, y, e.deltaY < 0 ? 1 : -1); return; }
        const p = this._panelAt(x, y);
        if (!p) return;
        this.zoomStep(e.deltaY < 0 ? 1 : -1, p, x);
      }, { passive: false });
      cv.addEventListener('pointerdown', (e) => {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (this.scope.isXY()) { if (this._xyDown(x, y)) cv.setPointerCapture(e.pointerId); return; }
        const p = this._panelAt(x, y);
        if (!p) return;
        const s = this.scope.s;
        let kind = 'pan';
        if (x > p.x + p.w - 4 && !this.scope.isRoll()) kind = 'level';
        else if (x < p.x + 4) {
          // 가까운 채널 마커
          let best = -1, bd = 1e9;
          for (let c = 0; c < 2; c++) if (s.ch[c].on) { const yy = p.y + p.h / 2 - s.ch[c].pos * p.h / 8; const d = Math.abs(yy - y); if (d < bd) { bd = d; best = c; } }
          if (best >= 0) kind = 'pos' + best; else return;
        } else if (p.kind === 'over') kind = 'zoomjump';
        cv.setPointerCapture(e.pointerId);
        this.drag = { kind: kind, p: p, x0: x, y0: y, delay0: s.delay, zc0: s.zoom.center, lvl0: s.trig.level, pos0: [s.ch[0].pos, s.ch[1].pos] };
        if (kind === 'zoomjump') this._zoomJump(p, x);
      });
      cv.addEventListener('pointermove', (e) => {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (this.scope.isXY()) { this._xyMove(x, y); return; }
        const d = this.drag;
        if (!d) {
          const p = this._panelAt(x, y);
          cv.style.cursor = !p ? 'default' : (x > p.x + p.w - 4 || x < p.x + 4) ? 'ns-resize' : (p.kind === 'over' ? 'pointer' : 'ew-resize');
          return;
        }
        const s = this.scope.s, p = d.p;
        if (d.kind === 'pan') {
          const span = p.win.R - p.win.L, dt = -(x - d.x0) / p.w * span;
          if (p.kind === 'zoom') { s.zoom.center = d.zc0 + dt; this.app.scopeChanged('zoom'); }
          else if (!this.scope.isRoll()) { s.delay = this._snapDelay(d.delay0 + dt); this.app.scopeChanged('horiz'); }
        } else if (d.kind === 'zoomjump') this._zoomJump(p, x);
        else if (d.kind === 'level') {
          const cs = s.ch[s.trig.source];
          s.trig.level = d.lvl0 - (y - d.y0) / (p.h / 8) * cs.vdiv;
          s.trig.level = Number(s.trig.level.toPrecision(4));
          this.flashLevel(); this.app.scopeChanged('trig');
        } else if (d.kind.startsWith('pos')) {
          const c = +d.kind[3];
          s.ch[c].pos = U.clamp(Math.round((d.pos0[c] - (y - d.y0) / (p.h / 8)) * 25) / 25, -8, 8);
          this.app.scopeChanged('vert');
        }
      });
      const end = () => { if (this.drag) { this.drag = null; this.app.saveSoon(); } };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('dblclick', (e) => {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (this.scope.isXY()) { if (this._xyHit(x, y) && this.scope.s.xy.zoom.on) { this.scope.s.xy.zoom.on = false; this.app.scopeChanged('xyzoom'); } return; }
        const p = this._panelAt(x, y);
        if (p && p.kind === 'zoom') { this.scope.s.zoom.on = false; this.app.scopeChanged('zoom'); }
      });
    }
    _snapDelay(v) {
      const st = this.scope.s.tdiv / 50;
      return Math.round(v / st) * st;
    }
    _zoomJump(p, x) {
      const m = p.win, s = this.scope.s;
      const t = m.L + (x - p.x) / p.w * (m.R - m.L);
      s.zoom.center = t - (m.L + m.R) / 2;
      this.app.scopeChanged('zoom');
    }
    /** 휠/노브에 의한 Zoom 단계 변경 */
    zoomStep(dir, p, mouseX) {
      const s = this.scope.s, H = this.scope.horiz();
      const maxF = Math.max(1, H.n / 10);
      let i = ZOOM_STEPS.indexOf(s.zoom.on ? s.zoom.factor : 1);
      if (i < 0) i = 0;
      i = U.clamp(i + dir, 0, ZOOM_STEPS.length - 1);
      let f = ZOOM_STEPS[i];
      if (f > maxF) f = ZOOM_STEPS.filter(v => v <= maxF).pop() || 1;
      const wasOn = s.zoom.on;
      if (f <= 1) { s.zoom.on = false; s.zoom.factor = 2; }
      else {
        if (!wasOn && p && mouseX !== undefined && p.kind === 'main') {
          const m = p.win; const t = m.L + (mouseX - p.x) / p.w * (m.R - m.L);
          s.zoom.center = t - (m.L + m.R) / 2;
        } else if (wasOn && p && p.kind === 'zoom' && mouseX !== undefined) {
          // 마우스 위치를 고정점으로 확대
          const z = p.win, t = z.L + (mouseX - p.x) / p.w * (z.R - z.L);
          const m = this.scope.mainWindow(this.scope.record);
          const newW = (m.R - m.L) / f, frac = (mouseX - p.x) / p.w;
          s.zoom.center = (t - frac * newW + newW / 2) - (m.L + m.R) / 2;
        }
        s.zoom.on = true; s.zoom.factor = f;
      }
      this.app.scopeChanged('zoom');
    }
  }

  VS.ScopeView = ScopeView;
  VS.ZOOM_STEPS = ZOOM_STEPS;
})(window);
