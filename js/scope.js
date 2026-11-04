/* scope.js — 가상 디지털 오실로스코프 획득 엔진
 *
 *  - 시뮬레이션 클럭 기반: process(tA, tB) 로 시뮬레이션 시간 구간 단위로 진행.
 *  - 트리거: 소스 채널의 (필터/커플링 적용) 연속 신호에서 레벨 교차 시각을 해석적으로 탐색 → 서브샘플 정확도.
 *  - 레코드: 트리거 시각 기준 [-p·W + D, (1-p)·W + D] 구간을 Record Length 개 샘플로 획득.
 *    (W = 10 div × Time/div, p = Pre-trigger 비율, D = Horizontal Position(Delay))
 *  - 획득 데이터는 화면 표시와 별도로 보관 → Stop / Zoom / 설정 변경 시에도 원본 유지.
 *  - Acquisition Mode: Sample / Peak Detect / Average,  Trigger Mode: Auto / Normal / Single
 *  - ADC 모델: 8bit (25 LSB/div, ±5.12 div 범위), 입력 환산 잡음(선택)
 *  - XY 모드: Time/div·Edge Trigger 없이 Simulation Clock 격자 t_k = k/fs 에서 CH1·CH2 를 "동일 시각"에
 *    연속 샘플링하여 (X=CH1, Y=CH2) 좌표 쌍을 링버퍼에 보관. 두 채널 중 하나라도 Probe 미연결/핀 Disable/
 *    채널 OFF 이면 획득·표시를 중단한다.
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
  // XY 모드
  const XY_SR_LIST = U.seq125(1e3, 100e6);
  const XY_RL_LIST = U.seq125(1000, 100000);
  const XY_PERSIST_LIST = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, -1];   // 잔상 유지 시간 (s, Simulation Clock), -1 = 무한 누적
  const XY_CAP_MAX = 262144;    // XY 링버퍼 최대 용량 (표시 점 수 + 잔상 누적용 여유)

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
      display: { vectors: true, noise: true, measure: true, persist: false },
      mode: 'yt',                       // 'yt' : X = 시간, Y = 전압  |  'xy' : X = CH1 전압, Y = CH2 전압
      xy: {
        sr: 1e6, rl: 5000,              // XY 샘플레이트 / 표시 점 수 (궤적 길이 = rl / sr)
        draw: 'line',                   // 'line' | 'dot' | 'persist'
        persist: 0.5,                   // 잔상 유지 시간 (s), -1 = 무한 누적
        zoom: { on: false, factor: 2, cx: 0, cy: 0 }   // cx, cy: 확대 중심 (비확대 화면 div 좌표)
      }
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
      this.xyBuf = null;            // XY 링버퍼
      this.xyEpoch = 0;
      this.xySingle = false;
    }
    static get TDIV_LIST() { return TDIV_LIST; }
    static get RL_LIST() { return RL_LIST; }
    static get SR_LIST() { return SR_LIST; }
    static get AVG_LIST() { return AVG_LIST; }
    static vdivList(probe) { return VDIV_LIST_1X.map(v => Number((v * probe).toPrecision(6))); }
    static get defaults() { return defaultSettings(); }
    static get XY_SR_LIST() { return XY_SR_LIST; }
    static get XY_RL_LIST() { return XY_RL_LIST; }
    static get XY_PERSIST_LIST() { return XY_PERSIST_LIST; }

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
      if (on) { this.a.state = 'idle'; this.xyBuf = null; }   // XY: Run 재개 시 새 궤적부터 (Stop 구간은 획득하지 않음)
      this.xySingle = false;
      this.status = on ? 'Ready' : 'Stop';
    }
    single() {
      this.avg = null;
      this.a.state = 'idle';
      this.running = true;
      this.rollState = null;
      if (this.isXY()) { this.xyBuf = null; this.xySingle = true; this.status = 'Ready'; return; }   // XY: 궤적 1개(rl 점) 획득 후 정지
      this.s.trig.mode = 'single';
    }
    forceTrigger() { if (!this.isXY()) this.forceReq = true; }

    // ---------------- XY 모드 ----------------
    isXY() { return this.s.mode === 'xy'; }
    /** Y-T ↔ XY 전환: 진행 중 획득을 버리고 새 모드로 재시작 */
    setMode(m) {
      m = m === 'xy' ? 'xy' : 'yt';
      if (this.s.mode === m) return;
      this.s.mode = m;
      this.a.state = 'idle'; this.avg = null; this.rollState = null; this.forceReq = false;
      this.xyBuf = null; this.xySingle = false;
      if (this.running) this.status = 'Ready';
    }
    /** XY 획득 파라미터: fs, 표시 점 수 n, 샘플 간격 dt, 궤적 길이 W = n·dt, 링버퍼 용량 cap */
    xyHoriz() {
      const x = this.s.xy;
      const fs = U.clamp(+x.sr || 1e6, XY_SR_LIST[0], XY_SR_LIST[XY_SR_LIST.length - 1]);
      const n = Math.round(U.clamp(+x.rl || 5000, 10, XY_RL_LIST[XY_RL_LIST.length - 1]));
      const dt = 1 / fs;
      const cap = Math.max(n, Math.min(XY_CAP_MAX, Math.ceil(fs * 0.1)));
      return { fs: fs, n: n, dt: dt, W: n * dt, cap: cap };
    }
    /** XY 표시 불가 사유 목록 (빈 배열 = 정상): 두 채널 모두 Probe 연결 · 핀 Enable · 채널 ON 이어야 한다 */
    xyBlock() {
      const out = [];
      for (let c = 0; c < 2; c++) {
        const inp = this.inputs[c], nm = 'CH' + (c + 1);
        if (!inp.pin) out.push({ ch: c, code: 'noprobe', text: nm + ' Probe 미연결' });
        else if (!inp.pin.enabled) out.push({ ch: c, code: 'disabled', text: nm + ' (' + inp.pin.name + ') 핀 Disable' });
        if (!this.s.ch[c].on) out.push({ ch: c, code: 'off', text: nm + ' 채널 OFF' });
      }
      return out;
    }
    xyReset() { this.xyBuf = null; }
    _xyNew(H, key, tA) {
      const k0 = Math.floor(tA / H.dt + 1e-9);
      return {
        key: key, cap: H.cap, dt: H.dt, kStart: k0 + 1, kLast: k0, epoch: ++this.xyEpoch, skipped: 0,
        x: new Float32Array(H.cap), y: new Float32Array(H.cap), tmpX: new Float32Array(H.cap), tmpY: new Float32Array(H.cap),
        pins: [this.inputs[0].label, this.inputs[1].label]
      };
    }
    /** XY 연속 획득: (tA, tB] 에 속하는 격자 시각 t_k = k·dt 에서 CH1, CH2 를 동일 시각으로 샘플링 */
    _processXY(tA, tB) {
      if (this.xyBlock().length) {          // 획득/표시 중단 → 조건 회복 시 새 궤적으로 시작
        this.xyBuf = null;
        this.status = 'Hold';
        return;
      }
      const H = this.xyHoriz(), key = H.cap + ',' + H.dt;
      let B = this.xyBuf;
      if (!B || B.key !== key) B = this.xyBuf = this._xyNew(H, key, tA);
      this.status = 'XY';
      const kNow = Math.floor(tB / B.dt + 1e-9);
      let m = kNow - B.kLast;
      if (m <= 0) return;
      if (m > B.cap) { B.skipped += m - B.cap; B.kLast = kNow - B.cap; m = B.cap; }   // 버퍼 용량 초과분(가장 오래된 것)은 획득 생략
      const ta = (B.kLast + 1) * B.dt;
      const vx = B.tmpX.subarray(0, m), vy = B.tmpY.subarray(0, m);
      this.inputs[0].tl.sample(ta, B.dt, m, vx);    // CH1 → X   (필터/커플링 적용된 동일 신호 체인)
      this.inputs[1].tl.sample(ta, B.dt, m, vy);    // CH2 → Y   (같은 ta, dt → 같은 시각)
      this._adc(0, vx); this._adc(1, vy);
      const cap = B.cap, bx = B.x, by = B.y;
      let idx = (B.kLast + 1) % cap;
      for (let j = 0; j < m; j++) {
        bx[idx] = vx[j]; by[idx] = vy[j];
        if (++idx === cap) idx = 0;
      }
      B.kLast = kNow;
      if (this.xySingle && B.kLast - B.kStart + 1 >= H.n) { this.xySingle = false; this.running = false; this.status = 'Stop'; }
    }
    /** XY 샘플 구간 복사 (시간 순). maxN: 최근 maxN 개(기본 = 표시 점 수), kFrom: 이 인덱스 이후만 */
    xyRecord(maxN, kFrom) {
      const B = this.xyBuf;
      if (!B || B.kLast < B.kStart) return null;
      const n = maxN || this.xyHoriz().n;
      let kFirst = Math.max(B.kStart, B.kLast - B.cap + 1, B.kLast - n + 1);
      if (kFrom !== undefined && kFrom > kFirst) kFirst = kFrom;
      const cnt = Math.max(0, B.kLast - kFirst + 1);
      const x = new Float32Array(cnt), y = new Float32Array(cnt);
      let idx = kFirst % B.cap;
      for (let j = 0; j < cnt; j++) { x[j] = B.x[idx]; y[j] = B.y[idx]; if (++idx === B.cap) idx = 0; }
      return { k0: kFirst, dt: B.dt, n: cnt, x: x, y: y, t0: kFirst * B.dt, tEnd: B.kLast * B.dt, epoch: B.epoch, pins: B.pins };
    }
    /** 최신 XY 샘플 (빔 위치) */
    xyLatest() {
      const B = this.xyBuf;
      if (!B || B.kLast < B.kStart) return null;
      const i = B.kLast % B.cap;
      return { x: B.x[i], y: B.y[i], t: B.kLast * B.dt };
    }
    /** MAX 속도에서 한 번에 진행할 시뮬레이션 구간 */
    maxChunk() {
      if (this.isXY()) { const X = this.xyHoriz(); return Math.max(X.cap * X.dt, 0.002); }
      return Math.max(this.horiz().W * 2, 0.1);
    }

    /** 획득 대기 중일 때 보존해야 하는 가장 이른 시각 */
    keepTime(tB) {
      if (this.isXY()) return tB - this.xyHoriz().dt * 4;
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
      if (this.isXY()) { this._processXY(tA, tB); return; }
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
      this.xyBuf = null; this.xySingle = false;
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

  /** XY: 기본파(주파수 f) 기준 CH2 의 CH1 대비 위상차(°)와 진폭비 |Y|/|X| — 정수 주기 구간 단일 bin DFT */
  function xyPhase(x, y, n, dt, f) {
    const res = { phase: NaN, gain: NaN, periods: 0 };
    if (!(f > 0) || !(n > 2)) return res;
    const spp = 1 / (f * dt);
    const nP = Math.floor(n / spp + 1e-9);
    if (nP < 1) return res;
    const M = Math.min(n, Math.round(nP * spp));
    let mx = 0, my = 0;
    for (let i = 0; i < M; i++) { mx += x[i]; my += y[i]; }
    mx /= M; my /= M;
    const w = 2 * Math.PI * f * dt, cw = Math.cos(w), sw = Math.sin(w);
    let c = 1, s = 0, xr = 0, xi = 0, yr = 0, yi = 0;
    for (let i = 0; i < M; i++) {
      const a = x[i] - mx, b = y[i] - my;
      xr += a * c; xi -= a * s; yr += b * c; yi -= b * s;
      const c2 = c * cw - s * sw; s = s * cw + c * sw; c = c2;     // 회전 점화식 (삼각함수 호출 없음)
    }
    const ax = Math.hypot(xr, xi), ay = Math.hypot(yr, yi);
    if (!(ax > 1e-12) || !(ay > 1e-12)) return res;
    let d = (Math.atan2(yi, yr) - Math.atan2(xi, xr)) * 180 / Math.PI;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    res.phase = d; res.gain = ay / ax; res.periods = nP;
    return res;
  }

  // ------------------------------------------------------------------
  // CSV 저장
  function fmtV(v) { return v === v ? String(Number(v.toPrecision(6))) : ''; }
  function tDecimals(dt) { return U.clamp(Math.ceil(-Math.log10(dt) - 1e-9) + 3, 3, 15); }
  /** XY 레코드 → CSV: Timestamp(Simulation Clock), CH1 Voltage (X), CH2 Voltage (Y) */
  function xyCSV(rec) {
    const d = tDecimals(rec.dt), out = ['Timestamp (s),CH1 Voltage X (V),CH2 Voltage Y (V)'];
    for (let i = 0; i < rec.n; i++) out.push(((rec.k0 + i) * rec.dt).toFixed(d) + ',' + fmtV(rec.x[i]) + ',' + fmtV(rec.y[i]));
    return out.join('\n') + '\n';
  }
  /** Y-T 레코드 → CSV: Timestamp(Simulation Clock), 채널별 전압 (Peak Detect 는 Min/Max) */
  function ytCSV(rec) {
    const hdr = ['Timestamp (s)'], cols = [];
    for (let c = 0; c < 2; c++) {
      const info = rec.ch[c];
      if (!info) continue;
      if (info.data) { hdr.push('CH' + (c + 1) + ' Voltage (V)'); cols.push(info.data); }
      else { hdr.push('CH' + (c + 1) + ' Min (V)', 'CH' + (c + 1) + ' Max (V)'); cols.push(info.min, info.max); }
    }
    const d = tDecimals(rec.dt), out = [hdr.join(',')];
    for (let i = 0; i < rec.n; i++) {
      let any = false, row = (rec.t0 + i * rec.dt).toFixed(d);
      for (const a of cols) { const v = a[i]; if (v === v) any = true; row += ',' + fmtV(v); }
      if (any) out.push(row);
    }
    return out.join('\n') + '\n';
  }

  VS.Scope = Scope;
  VS.scopeMeasure = measure;
  VS.xyPhase = xyPhase;
  VS.xyCSV = xyCSV;
  VS.ytCSV = ytCSV;
  VS.SCOPE_CONST = { FS_MAX, RL_MAX, ROLL_TDIV, ADC_LSB_PER_DIV, ADC_HALF_RANGE, XY_CAP_MAX };
})(typeof window !== 'undefined' ? window : globalThis);
