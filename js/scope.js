/* scope.js — 가상 디지털 오실로스코프 획득 엔진
 *
 *  - 시뮬레이션 클럭 기반: process(tA, tB) 로 시뮬레이션 시간 구간 단위로 진행.
 *  - 트리거: 소스 채널의 (필터/커플링 적용) 연속 신호에서 레벨 교차 시각을 해석적으로 탐색 → 서브샘플 정확도.
 *  - 레코드: 트리거 시각 기준 [-p·W + D, (1-p)·W + D] 구간을 Record Length 개 샘플로 획득.
 *    (W = 10 div × Time/div, p = Pre-trigger 비율, D = Horizontal Position(Delay))
 *  - 획득 데이터는 화면 표시와 별도로 보관 → Stop / Zoom / 설정 변경 시에도 원본 유지.
 *  - Acquisition Mode: Sample / Peak Detect / Average,  Trigger Mode: Auto / Normal / Single
 *  - ADC 모델: 8bit (25 LSB/div, ±5.12 div 범위), 입력 환산 잡음(선택)
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const U = VS.util;

  const FS_MAX = 10e9;          // 최대 샘플레이트 10 GSa/s
  const RL_MAX = 1000000;       // 최대 레코드 길이
  const RL_MIN = 10;
  const ROLL_TDIV = 0.1;        // Roll 모드 진입 Time/div (Auto 트리거 시)
  const ADC_LSB_PER_DIV = 25;
  const ADC_HALF_RANGE = 5.12;  // div

  const TDIV_LIST = U.seq125(1e-9, 50);
  const VDIV_LIST_1X = U.seq125(1e-3, 10);
  const RL_LIST = [1000, 10000, 100000, 1000000];
  const SR_LIST = U.seq125(1, FS_MAX);
  const AVG_LIST = [2, 4, 8, 16, 32, 64, 128, 256];

  function defaultSettings() {
    return {
      ch: [
        { on: true, vdiv: 1, pos: 0.5, coupling: 'DC', probe: 10 },
        { on: true, vdiv: 1, pos: -3.5, coupling: 'DC', probe: 10 }
      ],
      tdiv: 500e-6,
      delay: 0,                         // Horizontal Position (s): 트리거 → 기준점 지연
      zoom: { on: false, factor: 5, center: 0 },  // center: 메인 창 중심 기준 시간 오프셋(s)
      trig: { mode: 'auto', source: 0, slope: 'rise', level: 1.65, pos: 0.5 },
      acq: { mode: 'sample', avgN: 16, rl: 10000, srMode: 'auto', sr: 100e6 },
      roll: true,
      display: { vectors: true, noise: true, measure: true, persist: false }
    };
  }

  class Scope {
    constructor(inputs) {
      this.inputs = inputs;
      this.s = defaultSettings();
      this.running = true;
      this.a = { state: 'idle', armT: 0, readyT: 0, cursor: 0, autoT: 0, trigT: 0, forced: false };
      this.record = null;
      this.recId = 0;
      this.avg = null;
      this.rollState = null;
      this.rng = new U.Rng(20240611);
      this.status = 'Ready';
      this.lastForced = false;
      this.wfmCount = 0;
      this.forceReq = false;
      this.lastProcessT = 0;
      this.onRecord = null;
    }
    static get TDIV_LIST() { return TDIV_LIST; }
    static get RL_LIST() { return RL_LIST; }
    static get SR_LIST() { return SR_LIST; }
    static get AVG_LIST() { return AVG_LIST; }
    static vdivList(probe) { return VDIV_LIST_1X.map(v => Number((v * probe).toPrecision(6))); }
    static get defaults() { return defaultSettings(); }

    /** 수평축 파라미터: W = RL / fs = 10·T/div 관계 유지 */
    horiz() {
      const s = this.s, W = 10 * s.tdiv;
      let fs, n, limited = '';
      if (s.acq.srMode === 'auto') {
        fs = s.acq.rl / W;
        if (fs > FS_MAX) { fs = FS_MAX; limited = 'fs'; }
        n = Math.round(fs * W);
      } else {
        fs = Math.min(s.acq.sr, FS_MAX);
        n = Math.round(fs * W);
        if (n > RL_MAX) { n = RL_MAX; limited = 'rl'; }
      }
      if (n < RL_MIN) { n = RL_MIN; limited = 'min'; }
      fs = n / W;
      return { W: W, fs: fs, n: n, dt: W / n, limited: limited };
    }
    isRoll() {
      const s = this.s;
      return s.roll && s.trig.mode === 'auto' && s.tdiv >= ROLL_TDIV - 1e-12;
    }
    /** 설정 변경 → 진행 중 획득 취소 후 재무장 */
    rearm() { if (this.a.state !== 'idle') this.a.state = 'idle'; this.avg = null; }
    setRunning(on) {
      this.running = on;
      if (on) { this.a.state = 'idle'; }
      this.status = on ? 'Ready' : 'Stop';
    }
    single() {
      this.s.trig.mode = 'single';
      this.avg = null;
      this.a.state = 'idle';
      this.running = true;
      this.rollState = null;
    }
    forceTrigger() { this.forceReq = true; }

    /** 획득 대기 중일 때 보존해야 하는 가장 이른 시각 */
    keepTime(tB) {
      const H = this.horiz(), a = this.a, s = this.s;
      if (this.isRoll()) return tB - H.dt * 4;
      let t = tB - H.W - Math.abs(s.delay);
      if (a.state === 'armed') t = Math.min(t, a.readyT - H.W - Math.abs(s.delay), a.cursor - H.W - Math.abs(s.delay));
      if (a.state === 'triggered') t = Math.min(t, a.trigT - H.W - Math.abs(s.delay));
      return t - H.dt * 4;
    }

    _arm(t, H) {
      const a = this.a, s = this.s;
      a.state = 'armed'; a.armT = t;
      const pre = Math.max(0, s.trig.pos * H.W - s.delay);
      a.readyT = t + pre;
      a.cursor = a.readyT;
      a.autoT = a.readyT + Math.max(H.W, 0.02);
    }

    /** 시뮬레이션 시간 (tA, tB] 처리 */
    process(tA, tB) {
      this.lastProcessT = tB;
      if (!this.running) { this.status = 'Stop'; return; }
      const H = this.horiz();
      if (this.isRoll()) { this._roll(tB, H); return; }
      if (this.rollState) { this.rollState = null; this.a.state = 'idle'; }
      const a = this.a, s = this.s, tr = s.trig;
      if (a.state === 'idle') this._arm(tA, H);
      if (a.state === 'armed') {
        if (tB < a.readyT && !this.forceReq) { this.status = 'Armed'; return; }
        const from = Math.max(a.cursor, a.readyT);
        let to = tB;
        if (tr.mode === 'auto') to = Math.min(tB, a.autoT);
        const tl = this.inputs[tr.source].tl;
        const tc = to > from ? tl.findCrossing(from, to, tr.level, tr.slope === 'rise') : -1;
        if (tc >= 0) { a.trigT = tc; a.forced = false; a.state = 'triggered'; }
        else if (this.forceReq) { a.trigT = tB; a.forced = true; a.state = 'triggered'; }
        else if (tr.mode === 'auto' && tB >= a.autoT) { a.trigT = a.autoT; a.forced = true; a.state = 'triggered'; }
        else {
          a.cursor = Math.max(from, to);
          this.status = (tr.mode === 'auto' && this.lastForced) ? 'Auto' : 'Ready';
          return;
        }
        this.forceReq = false;
      }
      if (a.state === 'triggered') {
        const recStart = a.trigT - tr.pos * H.W + s.delay;
        const doneT = Math.max(recStart + H.W, a.trigT);
        if (tB < doneT) { this.status = a.forced ? 'Auto' : "Trig'd"; return; }
        this._capture(recStart, H, tB);
        a.state = 'idle';
        this.lastForced = a.forced;
        this.status = a.forced ? 'Auto' : "Trig'd";
        if (tr.mode === 'single' && (s.acq.mode !== 'average' || (this.avg && this.avg.count >= s.acq.avgN))) {
          this.running = false;
          this.status = 'Stop';
          return;
        }
        this._arm(tB, H);
      }
    }

    _sigma(c) {
      const cs = this.s.ch[c];
      return this.s.display.noise ? (0.25e-3 * cs.probe + 0.004 * cs.vdiv) : 0;   // 입력 환산 잡음 (rms)
    }
    _adc(c, v, noNoise) {
      // v: Float32Array (V) — 입력 환산 잡음 + 8bit 양자화 + 클리핑
      const cs = this.s.ch[c], rng = this.rng;
      const sigma = noNoise ? 0 : this._sigma(c);
      const vd = cs.vdiv, pos = cs.pos;
      const lsb = 1 / ADC_LSB_PER_DIV;
      const cmin = -Math.round(ADC_HALF_RANGE * ADC_LSB_PER_DIV), cmax = -cmin - 1;
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x !== x) continue;
        let code = Math.round(((sigma ? x + sigma * rng.gauss() : x) / vd + pos) * ADC_LSB_PER_DIV);
        if (code < cmin) code = cmin; else if (code > cmax) code = cmax;
        v[i] = (code * lsb - pos) * vd;
      }
    }
    _adcPeak(c, mn, mx) {
      const sigma = this._sigma(c);
      if (sigma) {
        // Peak Detect 는 고속 ADC 샘플의 최소/최대 → 잡음 포락선(약 ±2σ)
        for (let i = 0; i < mn.length; i++) {
          mn[i] = mn[i] - sigma * (2 + Math.abs(this.rng.gauss()) * 0.5);
          mx[i] = mx[i] + sigma * (2 + Math.abs(this.rng.gauss()) * 0.5);
        }
      }
      this._adc(c, mn, true); this._adc(c, mx, true);
    }

    _snapCh(c) {
      const cs = this.s.ch[c], inp = this.inputs[c];
      return { vdiv: cs.vdiv, pos: cs.pos, coupling: cs.coupling, probe: cs.probe, pin: inp.label };
    }

    _capture(recStart, H, tB) {
      const s = this.s, mode = s.acq.mode, n = H.n, dt = H.dt;
      const rec = {
        id: ++this.recId, kind: 'trig', t0: recStart, dt: dt, n: n, tRef: this.a.trigT,
        forced: this.a.forced, mode: mode, ch: [null, null], horiz: H, capturedAt: tB,
        trigPos: s.trig.pos, delay: s.delay, avgCount: 0
      };
      const avgKey = [n, dt, s.trig.pos, s.delay, s.ch[0].on, s.ch[1].on, s.ch[0].vdiv, s.ch[1].vdiv, s.ch[0].pos, s.ch[1].pos].join(',');
      if (mode === 'average' && (!this.avg || this.avg.key !== avgKey)) this.avg = { key: avgKey, count: 0, acc: [null, null] };
      if (mode === 'average') this.avg.count = Math.min(this.avg.count + 1, s.acq.avgN);
      for (let c = 0; c < 2; c++) {
        if (!s.ch[c].on) continue;
        const tl = this.inputs[c].tl;
        const info = this._snapCh(c);
        if (mode === 'peak') {
          const mn = new Float32Array(n), mx = new Float32Array(n);
          tl.samplePeak(recStart, dt, n, mn, mx);
          this._adcPeak(c, mn, mx);
          info.min = mn; info.max = mx;
        } else {
          const v = new Float32Array(n);
          tl.sample(recStart, dt, n, v);
          this._adc(c, v);
          if (mode === 'average') {
            let acc = this.avg.acc[c];
            if (!acc || acc.length !== n) { acc = this.avg.acc[c] = new Float64Array(n); acc.set(v); }
            else { const k = 1 / this.avg.count; for (let i = 0; i < n; i++) acc[i] += (v[i] - acc[i]) * k; }
            info.data = Float32Array.from(acc);
          } else info.data = v;
        }
        rec.ch[c] = info;
      }
      if (mode === 'average') rec.avgCount = this.avg.count;
      this.record = rec;
      this.wfmCount++;
      if (this.onRecord) this.onRecord(rec);
    }

    _roll(tB, H) {
      const s = this.s, mode = s.acq.mode === 'peak' ? 'peak' : 'sample';
      const key = [H.n, H.dt, s.ch[0].on, s.ch[1].on, mode].join(',');
      let R = this.rollState;
      const kNow = Math.floor(tB / H.dt + 1e-9);
      if (!R || R.key !== key) {
        R = this.rollState = { key: key, n: H.n, dt: H.dt, kLast: kNow - H.n, mode: mode, data: [], min: [], max: [] };
        for (let c = 0; c < 2; c++) {
          if (mode === 'peak') { R.min[c] = new Float32Array(H.n).fill(NaN); R.max[c] = new Float32Array(H.n).fill(NaN); }
          else R.data[c] = new Float32Array(H.n).fill(NaN);
        }
      }
      let m = kNow - R.kLast;
      this.status = 'Roll';
      if (m > 0) {
        if (m > R.n) { R.kLast = kNow - R.n; m = R.n; }
        const tFirst = (R.kLast + 1) * R.dt;
        for (let c = 0; c < 2; c++) {
          const tl = this.inputs[c].tl;
          if (!s.ch[c].on) continue;
          if (mode === 'peak') {
            const mn = new Float32Array(m), mx = new Float32Array(m);
            tl.samplePeak(tFirst, R.dt, m, mn, mx);
            this._adcPeak(c, mn, mx);
            R.min[c].copyWithin(0, m); R.min[c].set(mn, R.n - m);
            R.max[c].copyWithin(0, m); R.max[c].set(mx, R.n - m);
          } else {
            const v = new Float32Array(m);
            tl.sample(tFirst, R.dt, m, v);
            this._adc(c, v);
            R.data[c].copyWithin(0, m); R.data[c].set(v, R.n - m);
          }
        }
        R.kLast = kNow;
      }
      const tLast = R.kLast * R.dt;
      const rec = {
        id: ++this.recId, kind: 'roll', t0: tLast - (R.n - 1) * R.dt, dt: R.dt, n: R.n, tRef: tLast,
        forced: false, mode: mode, ch: [null, null], horiz: H, capturedAt: tB, trigPos: 1, delay: 0, avgCount: 0
      };
      for (let c = 0; c < 2; c++) {
        if (!s.ch[c].on) continue;
        const info = this._snapCh(c);
        if (mode === 'peak') { info.min = R.min[c]; info.max = R.max[c]; } else info.data = R.data[c];
        rec.ch[c] = info;
      }
      this.record = rec;
    }

    /** 현재 설정에서의 화면(메인) 시간창 — tRef(트리거) 기준 상대시간 [L, R] */
    mainWindow(rec) {
      const s = this.s, W = 10 * s.tdiv;
      if (rec && rec.kind === 'roll') return { L: -W, R: 0 };
      const L = -s.trig.pos * W + s.delay;
      return { L: L, R: L + W };
    }
    zoomWindow(rec) {
      const m = this.mainWindow(rec), z = this.s.zoom;
      const W = (m.R - m.L) / z.factor;
      const c0 = (m.L + m.R) / 2 + z.center;
      let L = c0 - W / 2;
      if (L < m.L) L = m.L;
      if (L + W > m.R) L = m.R - W;
      return { L: L, R: L + W };
    }
    resetAll() {
      this.a = { state: 'idle', armT: 0, readyT: 0, cursor: 0, autoT: 0, trigT: 0, forced: false };
      this.record = null; this.avg = null; this.rollState = null; this.wfmCount = 0; this.lastForced = false;
    }
  }

  // ------------------------------------------------------------------
  // 자동 측정
  function measure(rec, c, L, R) {
    if (!rec || !rec.ch[c]) return null;
    const info = rec.ch[c];
    const arr = info.data, mn = info.min, mx = info.max;
    const i0 = Math.max(0, Math.ceil((rec.tRef + L - rec.t0) / rec.dt - 1e-9));
    const i1 = Math.min(rec.n - 1, Math.floor((rec.tRef + R - rec.t0) / rec.dt + 1e-9));
    if (i1 - i0 < 2) return null;
    let vmax = -Infinity, vmin = Infinity, sum = 0, sum2 = 0, cnt = 0;
    const val = (i) => arr ? arr[i] : 0.5 * (mn[i] + mx[i]);
    for (let i = i0; i <= i1; i++) {
      const v = val(i);
      if (v !== v) continue;
      const lo = arr ? v : mn[i], hi = arr ? v : mx[i];
      if (hi > vmax) vmax = hi;
      if (lo < vmin) vmin = lo;
      sum += v; sum2 += v * v; cnt++;
    }
    if (!cnt) return null;
    const res = { vmax: vmax, vmin: vmin, vpp: vmax - vmin, vavg: sum / cnt, vrms: Math.sqrt(sum2 / cnt), freq: NaN, period: NaN, duty: NaN };
    const vpp = vmax - vmin;
    if (vpp > Math.max(1e-6, info.vdiv * 0.2)) {
      const mid = (vmax + vmin) / 2, hys = vpp * 0.1;
      let state = val(i0) > mid ? 1 : 0;
      const rises = [], falls = [];
      for (let i = i0 + 1; i <= i1; i++) {
        const v = val(i);
        if (v !== v) continue;
        if (state === 0 && v > mid + hys) {
          state = 1;
          // 중간 레벨 보간
          let k = i; while (k > i0 && val(k - 1) > mid) k--;
          const a = val(k - 1), b = val(k);
          rises.push(rec.t0 + (k - 1 + (b !== a ? (mid - a) / (b - a) : 0)) * rec.dt);
        } else if (state === 1 && v < mid - hys) {
          state = 0;
          let k = i; while (k > i0 && val(k - 1) < mid) k--;
          const a = val(k - 1), b = val(k);
          falls.push(rec.t0 + (k - 1 + (b !== a ? (mid - a) / (b - a) : 0)) * rec.dt);
        }
      }
      if (rises.length >= 2) {
        res.period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1);
        res.freq = 1 / res.period;
        // 듀티: 첫 상승엣지 이후 하강엣지
        let hiSum = 0, nP = 0;
        for (let r = 0; r + 1 < rises.length; r++) {
          const f = falls.find(t => t > rises[r] && t < rises[r + 1]);
          if (f !== undefined) { hiSum += (f - rises[r]) / (rises[r + 1] - rises[r]); nP++; }
        }
        if (nP) res.duty = 100 * hiSum / nP;
      }
    }
    return res;
  }

  VS.Scope = Scope;
  VS.scopeMeasure = measure;
  VS.SCOPE_CONST = { FS_MAX, RL_MAX, ROLL_TDIV, ADC_LSB_PER_DIV, ADC_HALF_RANGE };
})(typeof window !== 'undefined' ? window : globalThis);
