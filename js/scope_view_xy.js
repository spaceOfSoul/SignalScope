/* scope_view_xy.js — 오실로스코프 XY 모드 화면 (ScopeView 확장)
 *  - X축 = CH1 전압, Y축 = CH2 전압. 동일 Simulation Clock 시각 t_k 에서 샘플링된 (CH1, CH2) 쌍을
 *    하나의 좌표로 변환하여 시간 순서대로 연결(궤적) 표시
 *  - 표시 방식: Line(선 연결) / Dot(점) / Persistence(잔상: Simulation Clock 기준 일정 시간 유지 또는 무한 누적)
 *  - X/Y 축 전압 눈금 + 0 V 기준선 + 채널 위치 마커(드래그로 Position 조절)
 *  - Zoom: 휠(마우스 위치 고정), 드래그(확대 영역 이동), 오버뷰 클릭(이동), 더블클릭(해제)
 *  - 두 채널 중 하나라도 Probe 미연결 / 핀 Disable / 채널 OFF → 파형 표시 중단 + 사유 표시
 */
(function (G) {
  'use strict';
  const VS = G.VS, U = VS.util;
  const P = VS.ScopeView.prototype;
  const CH_COL = ['#ffd400', '#1fd6e8'];
  const XY_COL = '#7dff9a', XY_RGB = [125, 255, 154];
  const XY_ZOOM_STEPS = [1, 2, 4, 5, 10, 20, 25, 50];

  // 무한 누적 잔상: 히트 수 → (밝기, 색) 룩업 (로그 스케일, 밀도가 높을수록 흰색 쪽으로)
  const HIT_LUT = (function () {
    const N = 65536, lut = new Uint8ClampedArray(N * 4);
    for (let h = 1; h < N; h++) {
      const q = Math.min(1, Math.log1p(h) / Math.log1p(512));
      const w = 0.65 * Math.min(1, Math.log1p(h) / Math.log1p(8192));
      lut[h * 4] = XY_RGB[0] + (255 - XY_RGB[0]) * w;
      lut[h * 4 + 1] = XY_RGB[1] + (255 - XY_RGB[1]) * w;
      lut[h * 4 + 2] = XY_RGB[2] + (255 - XY_RGB[2]) * w;
      lut[h * 4 + 3] = 255 * (0.32 + 0.68 * q);
    }
    return lut;
  })();

  function fmtAxis(v, vd) {
    if (Math.abs(v) < vd * 1e-6) return '0';
    return U.fmtEng(v, 'V', 3);
  }

  // ---------------- 레이아웃 / 좌표 변환 ----------------
  P._xyLayout = function () {
    const s = this.scope.s, W = this.W, H = this.H;
    const top = 24, bottom = 24 + (s.display.measure ? 3 * 17 : 0) + 4;
    const padL = 66, padR = 14, padT = 6, padB = 34;     // 좌: Y 눈금 + CH2 마커, 하: CH1 마커 + X 눈금
    const ax = padL, ay = top + padT, aw = W - padL - padR, ah = H - top - bottom - padT - padB;
    const div = Math.max(6, Math.min(aw / 10, ah / 8));
    const pw = div * 10, ph = div * 8;
    const p = { kind: 'xy', x: Math.round(ax + (aw - pw) / 2), y: Math.round(ay + (ah - ph) / 2), w: pw, h: ph, div: div };
    return { top: top, bottom: bottom, panels: [p] };
  };
  /** 전압 → 화면 좌표:  X = x0 + v1·kx,  Y = y0 − v2·ky */
  P._xyMap = function (p) {
    const s = this.scope.s, z = s.xy.zoom;
    const f = z.on ? z.factor : 1, cx = z.on ? z.cx : 0, cy = z.on ? z.cy : 0;
    const c1 = s.ch[0], c2 = s.ch[1], g = f * p.div;
    return {
      f: f, cx: cx, cy: cy, g: g,
      kx: g / c1.vdiv, ky: g / c2.vdiv,
      x0: p.x + p.w / 2 + (c1.pos - cx) * g,      // CH1 0 V 의 화면 x
      y0: p.y + p.h / 2 - (c2.pos - cy) * g       // CH2 0 V 의 화면 y
    };
  };
  P.xyClampZoom = function () {
    const z = this.scope.s.xy.zoom, f = z.factor;
    z.cx = U.clamp(z.cx, -(5 - 5 / f), 5 - 5 / f);
    z.cy = U.clamp(z.cy, -(4 - 4 / f), 4 - 4 / f);
  };
  P.xyClearPersist = function () { this._xyPR = null; };

  // ---------------- 렌더 ----------------
  P._renderXY = function () {
    const ctx = this.ctx, sc = this.scope, s = sc.s;
    const L = this._xyLayout(); this.L = L;
    const p = L.panels[0], M = this._xyMap(p);
    const block = sc.xyBlock();
    const B = sc.xyBuf;
    this._xyInsetRect = null;
    this._grid(p);
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    this._xyZeroLines(p, M);
    if (!block.length && B) {
      if (s.xy.draw === 'persist') this._xyPersist(p, M, B);
      else this._xyTrace(p, M, B);
      this._xyBeam(M);
    }
    ctx.restore();
    this._xyAxes(p, M);
    this._xyMarkers(p, M);
    if (s.xy.zoom.on && !block.length) this._xyInset(p);
    if (block.length) this._xyBlocked(p, block);
    else if (!B || B.kLast < B.kStart) this._xyNote(p, sc.running ? 'XY 획득 대기…' : 'STOP — 획득된 XY 데이터 없음');
    this._xyTopBar(L);
    this._xyBottomBar(L, block);
  };

  P._xyZeroLines = function (p, M) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    if (M.x0 >= p.x && M.x0 <= p.x + p.w) {          // X = 0 V (CH1) 기준선
      ctx.strokeStyle = 'rgba(255,212,0,0.42)';
      ctx.beginPath(); ctx.moveTo(Math.round(M.x0) + 0.5, p.y); ctx.lineTo(Math.round(M.x0) + 0.5, p.y + p.h); ctx.stroke();
    }
    if (M.y0 >= p.y && M.y0 <= p.y + p.h) {          // Y = 0 V (CH2) 기준선
      ctx.strokeStyle = 'rgba(31,214,232,0.42)';
      ctx.beginPath(); ctx.moveTo(p.x, Math.round(M.y0) + 0.5); ctx.lineTo(p.x + p.w, Math.round(M.y0) + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (M.x0 >= p.x && M.x0 <= p.x + p.w && M.y0 >= p.y && M.y0 <= p.y + p.h) {
      ctx.strokeStyle = 'rgba(230,236,245,0.7)';
      ctx.beginPath(); ctx.arc(M.x0, M.y0, 3.5, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = 'rgba(230,236,245,0.75)'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('0,0', M.x0 + 5, M.y0 + 3);
    }
    ctx.restore();
  };

  /** Line / Dot: 최근 rl 개 좌표를 시간 순으로 */
  P._xyTrace = function (p, M, B) {
    const ctx = this.ctx, sc = this.scope, s = sc.s, dots = s.xy.draw === 'dot';
    const key = [B.epoch, B.kLast, sc.xyHoriz().n, M.kx, M.ky, M.x0, M.y0, dots].join('|');
    let path = this._xyPathKey === key ? this._xyPath : null;
    if (!path) {
      path = new Path2D();
      const rec = sc.xyRecord();
      if (rec) {
        const xs = rec.x, ys = rec.y, kx = M.kx, ky = M.ky, x0 = M.x0, y0 = M.y0;
        let lx = NaN, ly = NaN, pen = false;
        for (let i = 0; i < rec.n; i++) {
          const X = x0 + xs[i] * kx, Y = y0 - ys[i] * ky;
          if (X !== X || Y !== Y) { pen = false; continue; }
          if (dots) {
            if (Math.abs(X - lx) < 0.5 && Math.abs(Y - ly) < 0.5) continue;    // 같은 픽셀 중복 제거
            path.rect(X - 0.9, Y - 0.9, 1.8, 1.8); lx = X; ly = Y;
          } else if (!pen) { path.moveTo(X, Y); pen = true; lx = X; ly = Y; }
          else {
            if (Math.abs(X - lx) < 0.35 && Math.abs(Y - ly) < 0.35 && i < rec.n - 1) continue;
            path.lineTo(X, Y); lx = X; ly = Y;
          }
        }
        if (!dots && rec.n === 1) path.rect(lx - 0.9, ly - 0.9, 1.8, 1.8);
      }
      this._xyPathKey = key; this._xyPath = path;
    }
    ctx.strokeStyle = XY_COL; ctx.fillStyle = XY_COL;
    ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
    ctx.shadowColor = XY_COL; ctx.shadowBlur = 3;
    if (dots) ctx.fill(path); else ctx.stroke(path);
    ctx.shadowBlur = 0;
  };

  /** Persistence: 픽셀 래스터에 샘플 시각(Simulation Clock) 기록 → 경과 시간에 따라 감쇠 / 무한 누적은 밀도 표시 */
  P._xyPersist = function (p, M, B) {
    const ctx = this.ctx, sc = this.scope, s = sc.s;
    const w = Math.max(1, Math.round(p.w)), h = Math.max(1, Math.round(p.h));
    const key = [w, h, M.kx, M.ky, M.x0 - p.x, M.y0 - p.y].join('|');
    let R = this._xyPR;
    if (!R || R.key !== key) {            // 표시 설정 변경 → 잔상 초기화 후 보관된 샘플로 재구성
      const cv = (R && R.cv) || document.createElement('canvas');
      cv.width = w; cv.height = h;
      R = this._xyPR = {
        key: key, w: w, h: h, last: new Float64Array(w * h).fill(-Infinity), hits: new Uint16Array(w * h),
        cv: cv, img: cv.getContext('2d').createImageData(w, h), epoch: -1, pk: 0, lx: NaN, ly: NaN, dirty: true, tL: NaN, pst: NaN
      };
    }
    if (R.epoch !== B.epoch) { R.epoch = B.epoch; R.pk = B.kStart - 1; R.lx = NaN; }
    if (B.kLast > R.pk) {
      const rec = sc.xyRecord(B.cap, R.pk + 1);     // 마지막으로 그린 이후의 새 샘플 (용량 초과로 유실된 구간은 연결하지 않음)
      if (rec && rec.n) {
        if (rec.k0 > R.pk + 1) R.lx = NaN;
        this._xyRaster(R, rec, M, p.x, p.y);
      }
      R.pk = B.kLast; R.dirty = true;
    }
    const tL = B.kLast * B.dt, pst = s.xy.persist;
    if (R.dirty || R.tL !== tL || R.pst !== pst) {
      const d = R.img.data, last = R.last, hits = R.hits, n = w * h;
      const r = XY_RGB[0], g = XY_RGB[1], b = XY_RGB[2];
      if (pst < 0) {
        for (let i = 0, o = 0; i < n; i++, o += 4) {
          const hh = hits[i];
          if (!hh) { d[o + 3] = 0; continue; }
          const q = hh << 2;
          d[o] = HIT_LUT[q]; d[o + 1] = HIT_LUT[q + 1]; d[o + 2] = HIT_LUT[q + 2]; d[o + 3] = HIT_LUT[q + 3];
        }
      } else {
        const inv = 1 / pst;
        for (let i = 0, o = 0; i < n; i++, o += 4) {
          const lt = last[i];
          if (lt === -Infinity) { d[o + 3] = 0; continue; }
          const a = 1 - (tL - lt) * inv;
          if (a <= 0) { last[i] = -Infinity; hits[i] = 0; d[o + 3] = 0; continue; }
          const fresh = a > 0.92 ? (a - 0.92) * 6 : 0;    // 가장 최근 궤적은 흰색 쪽으로
          d[o] = r + (255 - r) * fresh; d[o + 1] = g + (255 - g) * fresh; d[o + 2] = b + (255 - b) * fresh;
          d[o + 3] = 255 * (0.1 + 0.9 * a * a);
        }
      }
      R.cv.getContext('2d').putImageData(R.img, 0, 0);
      R.dirty = false; R.tL = tL; R.pst = pst;
    }
    ctx.drawImage(R.cv, p.x, p.y, w, h);
  };
  P._xyRaster = function (R, rec, M, ox, oy) {
    const W = R.w, H = R.h, last = R.last, hits = R.hits;
    const xs = rec.x, ys = rec.y, kx = M.kx, ky = M.ky, bx = M.x0 - ox, by = M.y0 - oy;
    const plot = (x, y, t) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
      const i = yi * W + xi;
      last[i] = t;
      if (hits[i] < 65535) hits[i]++;
    };
    let lx = R.lx, ly = R.ly;
    for (let i = 0; i < rec.n; i++) {
      const X = bx + xs[i] * kx, Y = by - ys[i] * ky, t = (rec.k0 + i) * rec.dt;
      if (X !== X || Y !== Y) { lx = NaN; continue; }
      if (lx === lx) {
        const dx = X - lx, dy = Y - ly;
        const steps = Math.min(4096, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
        if (steps <= 1) plot(X, Y, t);
        else for (let k = 1; k <= steps; k++) plot(lx + dx * k / steps, ly + dy * k / steps, t);
      } else plot(X, Y, t);
      lx = X; ly = Y;
    }
    R.lx = lx; R.ly = ly;
  };

  /** 빔(최신 샘플) 위치 */
  P._xyBeam = function (M) {
    const sc = this.scope, b = sc.xyLatest();
    if (!b || !sc.running || this.sim.paused) return;
    const ctx = this.ctx, X = M.x0 + b.x * M.kx, Y = M.y0 - b.y * M.ky;
    ctx.save();
    ctx.fillStyle = '#ffffff'; ctx.shadowColor = XY_COL; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(X, Y, 2.2, 0, 2 * Math.PI); ctx.fill();
    ctx.restore();
  };

  /** X/Y 축 전압 눈금 (Zoom 반영) + 축 제목 */
  P._xyAxes = function (p, M) {
    const ctx = this.ctx, s = this.scope.s, c1 = s.ch[0], c2 = s.ch[1];
    const step = p.div >= 54 ? 1 : 2;
    ctx.save();
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(255,212,0,0.85)';
    for (let u = -5; u <= 5; u += step) {
      const x = p.x + p.w / 2 + u * p.div;
      const v = (M.cx + u / M.f - c1.pos) * c1.vdiv;
      ctx.fillText(fmtAxis(v, c1.vdiv), x, p.y + p.h + 20);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(31,214,232,0.9)';
    for (let j = -4; j <= 4; j += step) {
      const y = p.y + p.h / 2 - j * p.div;
      const v = (M.cy + j / M.f - c2.pos) * c2.vdiv;
      ctx.fillText(fmtAxis(v, c2.vdiv), p.x - 20, y);
    }
    // 축 제목 (화면 내부 모서리)
    ctx.font = 'bold 10.5px Consolas, monospace';
    const tag = (text, x, y, col, align) => {
      ctx.textAlign = align; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(5,6,7,0.75)'; ctx.fillRect(align === 'right' ? x - tw - 4 : x - 4, y - 8, tw + 8, 16);
      ctx.fillStyle = col; ctx.fillText(text, x, y + 0.5);
    };
    tag('Y = CH2 ' + U.fmtEng(c2.vdiv / M.f, 'V', 3) + '/div', p.x + 8, p.y + 11, CH_COL[1], 'left');
    tag('X = CH1 ' + U.fmtEng(c1.vdiv / M.f, 'V', 3) + '/div', p.x + p.w - 8, p.y + p.h - 11, CH_COL[0], 'right');
    ctx.restore();
  };

  /** 아래쪽(위를 가리키는) 마커: CH1 0 V 의 X 위치 */
  P._pennantUp = function (x, y, color, text, clampL, clampR) {
    const ctx = this.ctx;
    let arrow = 0;
    if (x < clampL) { x = clampL; arrow = -1; } else if (x > clampR) { x = clampR; arrow = 1; }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + 7, y + 5); ctx.lineTo(x + 7, y + 16); ctx.lineTo(x - 7, y + 16); ctx.lineTo(x - 7, y + 5);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#000'; ctx.font = 'bold 10px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(arrow ? (arrow < 0 ? '◀' : '▶') : text, x, y + 10.5);
  };
  P._xyMarkers = function (p, M) {
    this._pennant(p.x, M.y0, 1, CH_COL[1], '2', p.y + 7, p.y + p.h - 7);            // CH2 0 V (Y)
    this._pennantUp(M.x0, p.y + p.h + 1, CH_COL[0], '1', p.x + 7, p.x + p.w - 7);   // CH1 0 V (X)
  };

  /** Zoom 오버뷰 (우상단): 전체 화면 + 확대 영역 */
  P._xyInset = function (p) {
    const ctx = this.ctx, sc = this.scope, s = sc.s, z = s.xy.zoom;
    const iw = Math.round(U.clamp(p.w * 0.24, 110, 220)), ih = Math.round(iw * 0.8);
    const ix = Math.round(p.x + p.w - iw - 8), iy = Math.round(p.y + 8);
    this._xyInsetRect = { x: ix, y: iy, w: iw, h: ih };
    const dv = iw / 10, cxp = ix + iw / 2, cyp = iy + ih / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(5,6,7,0.9)'; ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = 'rgba(140,150,165,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round(ix + i * dv) + 0.5; ctx.moveTo(x, iy); ctx.lineTo(x, iy + ih); }
    for (let j = 1; j < 8; j++) { const y = Math.round(iy + j * dv) + 0.5; ctx.moveTo(ix, y); ctx.lineTo(ix + iw, y); }
    ctx.stroke();
    ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
    const rec = sc.xyRecord();
    if (rec && rec.n) {
      const c1 = s.ch[0], c2 = s.ch[1], st = Math.max(1, Math.ceil(rec.n / 3000));
      ctx.strokeStyle = XY_COL; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (let i = 0; i < rec.n; i += st) {
        const X = cxp + (rec.x[i] / c1.vdiv + c1.pos) * dv, Y = cyp - (rec.y[i] / c2.vdiv + c2.pos) * dv;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    const bw = 10 / z.factor * dv, bh = 8 / z.factor * dv;
    const bx = cxp + z.cx * dv - bw / 2, by = cyp - z.cy * dv - bh / 2;
    ctx.fillStyle = 'rgba(78,161,255,0.16)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(120,180,255,0.95)'; ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
    ctx.restore();
    ctx.strokeStyle = 'rgba(150,160,175,0.7)'; ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
    ctx.fillStyle = '#9cc8ff'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('ZOOM ×' + z.factor, ix + 4, iy + ih + 3);
  };

  P._xyBlocked = function (p, block) {
    const ctx = this.ctx;
    const lines = block.map(b => '• ' + b.text);
    const bw = Math.min(p.w - 20, 420), bh = 62 + lines.length * 17;
    const x = p.x + (p.w - bw) / 2, y = p.y + (p.h - bh) / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(40,14,14,0.92)'; ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = '#ff5b5b'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffb0b0'; ctx.font = 'bold 13px Consolas, monospace';
    ctx.fillText('⚠ XY 표시 중단', x + bw / 2, y + 16);
    ctx.font = '12px Consolas, monospace'; ctx.fillStyle = '#ffd7d7';
    lines.forEach((t, i) => ctx.fillText(t, x + bw / 2, y + 38 + i * 17));
    ctx.fillStyle = '#c9a3a3'; ctx.font = '11px Consolas, monospace';
    ctx.fillText('창 1 에서 두 채널 모두 Probe 연결 · Enable, 채널 ON 필요', x + bw / 2, y + bh - 13);
    ctx.restore();
  };
  P._xyNote = function (p, text) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(170,180,195,0.75)'; ctx.font = '12px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x + p.w / 2, p.y + p.h / 2 - 22);
    ctx.restore();
  };

  P._xyTopBar = function (L) {
    const sc = this.scope, s = sc.s, sim = this.sim, X = sc.xyHoriz();
    const y = 4;
    let x = 8;
    x = sc.running ? this._badge(x, y, 'RUN', '#1d7a40', '#d8ffe6') : this._badge(x, y, 'STOP', '#a32222', '#ffe0e0');
    const st = sc.running ? (sc.xySingle ? 'Single' : sc.status) : 'Stop';
    const stCol = { XY: ['#1f4d3a', '#a8ffd0'], Single: ['#6b4a12', '#ffd99a'], Ready: ['#4d4a14', '#fff2a0'], Hold: ['#6d1f1f', '#ffc6c6'], Stop: ['#3c3f46', '#ffb0b0'] }[st] || ['#3c3f46', '#ddd'];
    x = this._badge(x, y, st === 'XY' ? 'Acq' : st, stCol[0], stCol[1]);
    x = this._text(x, y + 9, 'XY  X=CH1 · Y=CH2', '#ffffff', true);
    if (s.xy.zoom.on) x = this._text(x, y + 9, 'Z ×' + s.xy.zoom.factor, '#9cc8ff', true);
    x = this._text(x, y + 9, U.fmtEng(X.fs, 'Sa/s') + '  ' + U.fmtEng(X.n, 'pts') + '  궤적 ' + U.fmtEng(X.W, 's', 3), '#c9d2de');
    const dm = s.xy.draw === 'line' ? 'Line' : s.xy.draw === 'dot' ? 'Dot' : ('Persist ' + (s.xy.persist < 0 ? '∞' : U.fmtEng(s.xy.persist, 's')));
    x = this._text(x, y + 9, dm, '#c9d2de');
    const ctx = this.ctx;
    ctx.textAlign = 'right'; ctx.font = '11.5px Consolas, monospace';
    ctx.fillStyle = sim.paused ? '#ffcf70' : '#9aa6b6';
    const sp = sim.speed === 'max' ? 'MAX' : sim.speed + 'X';
    ctx.fillText((sim.paused ? '⏸ PAUSED  ' : '') + 'sim ' + U.fmtSimTime(sim.simTime) + '  ' + sp + ' (' + (sim.actualSpeed >= 100 ? sim.actualSpeed.toFixed(0) : sim.actualSpeed.toFixed(2)) + 'x)', this.W - 8, y + 9);
  };

  P._xyBottomBar = function (L, block) {
    const s = this.scope.s, ctx = this.ctx, sim = this.sim;
    let y = this.H - L.bottom + 6, x = 8;
    for (let c = 0; c < 2; c++) {
      const cs = s.ch[c];
      const col = cs.on ? CH_COL[c] : '#555c66';
      ctx.fillStyle = col; ctx.fillRect(x, y, 16, 16);
      ctx.fillStyle = '#000'; ctx.font = 'bold 11px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(c + 1), x + 8, y + 8.5);
      x += 20;
      const pin = sim.inputs[c].label;
      const txt = (c === 0 ? 'X ' : 'Y ') + U.fmtEng(cs.vdiv, 'V', 3) + '/div ' + cs.coupling + ' ' + cs.probe + 'X ' + (pin === '—' ? '(no probe)' : pin);
      x = this._text(x, y + 8.5, txt, cs.on ? col : '#6c7480', true);
      x += 6;
    }
    this._text(x, y + 8.5, 'Time/div · Edge Trigger 비활성 (XY)', '#7d8796');
    if (!s.display.measure) return;
    const res = block.length ? null : this._xyMeasure();
    y += 20;
    const f = (v, u) => (v === v ? U.fmtMeas(v, u) : '--');
    ctx.font = '11px Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let c = 0; c < 2; c++) {
      const m = res && res.m[c];
      const t = (c === 0 ? 'CH1(X)' : 'CH2(Y)') + (m ? '  Vpp ' + f(m.vpp, 'V') + '  Vmax ' + f(m.vmax, 'V') + '  Vmin ' + f(m.vmin, 'V') + '  Vavg ' + f(m.vavg, 'V') +
        '  Vrms ' + f(m.vrms, 'V') + '  Freq ' + f(m.freq, 'Hz') : '  --');
      ctx.fillStyle = CH_COL[c]; ctx.fillText(t, 8, y + 8);
      y += 17;
    }
    const ph = res && res.ph;
    let t = 'XY      ';
    if (ph && ph.phase === ph.phase) {
      t += 'Δφ(CH2−CH1) ' + (ph.phase >= 0 ? '+' : '') + ph.phase.toFixed(1) + '°   |Y|/|X| ' + ph.gain.toFixed(3) + ' (' + (20 * Math.log10(ph.gain)).toFixed(2) + ' dB)' +
        '   @ ' + U.fmtMeas(res.f, 'Hz') + ' 기본파, ' + ph.periods + ' 주기';
    } else if (res && res.ratio === res.ratio) {
      t += '주파수비 Y/X = ' + res.ratio.toFixed(3) + '   (두 채널 주파수가 달라 위상차는 정의되지 않음)';
    } else t += 'Δφ / 진폭비: --  (두 채널 모두 궤적 구간에 2 주기 이상 필요)';
    ctx.fillStyle = XY_COL; ctx.fillText(t, 8, y + 8);
  };
  P._xyMeasure = function () {
    const sc = this.scope, s = sc.s, B = sc.xyBuf;
    if (!B) return null;
    const key = [B.epoch, B.kLast, sc.xyHoriz().n, s.ch[0].vdiv, s.ch[1].vdiv].join('|');
    const now = performance.now(), mc = this._xyMC;
    if (mc && (mc.key === key || (sc.running && now - mc.t < 250))) return mc.res;
    const rec = sc.xyRecord();
    let res = null;
    if (rec && rec.n >= 3) {
      const pr = { t0: rec.t0, dt: rec.dt, n: rec.n, tRef: rec.t0, ch: [{ data: rec.x, vdiv: s.ch[0].vdiv }, { data: rec.y, vdiv: s.ch[1].vdiv }] };
      const R = (rec.n - 1) * rec.dt;
      const m = [VS.scopeMeasure(pr, 0, 0, R), VS.scopeMeasure(pr, 1, 0, R)];
      const f1 = m[0] ? m[0].freq : NaN, f2 = m[1] ? m[1].freq : NaN;
      // 위상차/진폭비는 두 채널이 같은 주파수일 때만 정의 (±2 %)
      const ratio = f1 > 0 && f2 > 0 ? f2 / f1 : NaN, same = Math.abs(ratio - 1) < 0.02;
      const fr = same ? (f1 + f2) / 2 : NaN;
      res = { m: m, f: fr, ratio: ratio, ph: same ? VS.xyPhase(rec.x, rec.y, rec.n, rec.dt, fr) : null };
    }
    this._xyMC = { key: key, res: res, t: now };
    return res;
  };

  // ---------------- Zoom / 마우스 ----------------
  /** 휠/노브: Zoom 단계 변경. (mx, my) 지정 시 그 지점을 고정점으로 확대 */
  P.xyZoomStep = function (dir, mx, my) {
    const s = this.scope.s, z = s.xy.zoom, L = this.L, p = L && L.panels[0] && L.panels[0].kind === 'xy' ? L.panels[0] : null;
    const f0 = z.on ? z.factor : 1;
    let i = XY_ZOOM_STEPS.indexOf(f0);
    if (i < 0) i = U.nearestIndex(XY_ZOOM_STEPS, f0);
    i = U.clamp(i + dir, 0, XY_ZOOM_STEPS.length - 1);
    const f = XY_ZOOM_STEPS[i];
    if (f <= 1) { z.on = false; z.factor = 2; }
    else {
      const cx0 = z.on ? z.cx : 0, cy0 = z.on ? z.cy : 0;
      if (p && mx !== undefined) {
        const u = (mx - (p.x + p.w / 2)) / p.div, w = -(my - (p.y + p.h / 2)) / p.div;
        z.cx = cx0 + u / f0 - u / f; z.cy = cy0 + w / f0 - w / f;
      } else { z.cx = cx0; z.cy = cy0; }
      z.on = true; z.factor = f;
      this.xyClampZoom();
    }
    this.app.scopeChanged('xyzoom');
  };
  P._xyHit = function (x, y) {
    const p = this.L && this.L.panels[0];
    if (!p || p.kind !== 'xy') return null;
    const ins = this._xyInsetRect;
    if (ins && x >= ins.x && x <= ins.x + ins.w && y >= ins.y && y <= ins.y + ins.h) return 'xyjump';
    if (x >= p.x - 18 && x < p.x + 3 && y >= p.y - 4 && y <= p.y + p.h + 4) return 'ypos';
    if (y > p.y + p.h - 3 && y <= p.y + p.h + 18 && x >= p.x - 4 && x <= p.x + p.w + 4) return 'xpos';
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return 'area';
    return null;
  };
  P._xyWheel = function (x, y, dir) {
    if (this._xyHit(x, y)) this.xyZoomStep(dir, x, y);
  };
  P._xyDown = function (x, y) {
    const hit = this._xyHit(x, y);
    if (!hit) return false;
    const s = this.scope.s, z = s.xy.zoom;
    const kind = hit === 'area' ? (z.on ? 'xypan' : 'xyoff') : hit;
    this.drag = { kind: kind, p: this.L.panels[0], x0: x, y0: y, pos0: [s.ch[0].pos, s.ch[1].pos], cx0: z.cx, cy0: z.cy };
    if (kind === 'xyjump') this._xyJump(x, y);
    return true;
  };
  P._xyJump = function (x, y) {
    const ins = this._xyInsetRect, z = this.scope.s.xy.zoom;
    if (!ins) return;
    const dv = ins.w / 10;
    z.cx = (x - (ins.x + ins.w / 2)) / dv; z.cy = -(y - (ins.y + ins.h / 2)) / dv;
    this.xyClampZoom();
    this.app.scopeChanged('xyzoom');
  };
  P._xyMove = function (x, y) {
    const d = this.drag, cv = this.cv;
    if (!d) {
      const h = this._xyHit(x, y);
      cv.style.cursor = !h ? 'default' : h === 'ypos' ? 'ns-resize' : h === 'xpos' ? 'ew-resize' : h === 'xyjump' ? 'pointer' : 'move';
      return;
    }
    const s = this.scope.s, z = s.xy.zoom, p = d.p, g = p.div * (z.on ? z.factor : 1);
    const snap = (v) => U.clamp(Math.round(v * 25) / 25, -8, 8);
    if (d.kind === 'xpos' || d.kind === 'xyoff') s.ch[0].pos = snap(d.pos0[0] + (x - d.x0) / g);
    if (d.kind === 'ypos' || d.kind === 'xyoff') s.ch[1].pos = snap(d.pos0[1] - (y - d.y0) / g);
    if (d.kind === 'xpos' || d.kind === 'ypos' || d.kind === 'xyoff') { this.app.scopeChanged('vert'); return; }
    if (d.kind === 'xypan') {
      z.cx = d.cx0 - (x - d.x0) / g; z.cy = d.cy0 + (y - d.y0) / g;
      this.xyClampZoom();
      this.app.scopeChanged('xyzoom');
    } else if (d.kind === 'xyjump') this._xyJump(x, y);
  };

  VS.XY_ZOOM_STEPS = XY_ZOOM_STEPS;
  VS.XY_COLOR = XY_COL;
})(window);
