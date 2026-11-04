/* signal.js — 연속시간 신호 체인의 정확(해석적) 계산
 *
 * 모든 핀 출력은 "구간별 상수(GPIO/DAC)" 또는 "주기 PWM" 으로 표현된다.
 * 핀 필터(R-C LPF / C-R HPF)와 오실로스코프 AC 커플링은 1차 RC 단(stage)의 직렬 연결(Chain)로
 * 모델링하며, 입력이 상수인 구간에서는 지수함수 합으로 해석해를 구한다.
 *   - 각 단의 상태 = 커패시터 전압 v,  dv/dt = (in - v)/τ
 *   - LPF 출력 = v,  HPF 출력 = in - v
 * PWM 구간은 주기 사상(affine map)의 고정점을 이용해 k주기 점프를 O(1)로 계산하므로,
 * 100kHz PWM 을 수 초 동안 관측해도 전환 시점을 정확히 반영한다(샘플 단위 적분 없음).
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};

  const RAW_CONST = 0, RAW_PWM = 1;

  function rawConst(v) { return { k: RAW_CONST, v: v }; }
  /** PWM: t0=카운터 원점(상승엣지), T=주기, Th=High 시간, hi/lo 레벨 */
  function rawPWM(t0, T, Th, hi, lo) {
    if (!(Th > 0)) return rawConst(lo);
    if (Th >= T) return rawConst(hi);
    return { k: RAW_PWM, t0: t0, T: T, Th: Th, hi: hi, lo: lo };
  }
  function rawEqual(a, b) {
    if (a.k !== b.k) return false;
    if (a.k === RAW_CONST) return a.v === b.v;
    return a.t0 === b.t0 && a.T === b.T && a.Th === b.Th && a.hi === b.hi && a.lo === b.lo;
  }
  function rawAverage(r) { return r.k === RAW_CONST ? r.v : r.lo + (r.hi - r.lo) * r.Th / r.T; }
  function phaseOf(r, t) {
    let ph = (t - r.t0) % r.T;
    if (ph < 0) ph += r.T;
    if (ph >= r.T) ph = 0;
    return ph;
  }
  /** 시각 t 에서의 입력(우연속) */
  function rawRight(r, t) {
    if (r.k === RAW_CONST) return r.v;
    return phaseOf(r, t) < r.Th ? r.hi : r.lo;
  }
  /** 시각 t 직전의 입력(좌극한) */
  function rawLeft(r, t) {
    if (r.k === RAW_CONST) return r.v;
    const ph = phaseOf(r, t);
    return (ph > 0 && ph <= r.Th) ? r.hi : r.lo;
  }

  /** 시각 t(우연속)가 속한 반주기 {hs, he, u} — 부동소수 경계 보정 포함 */
  function halfAt(r, t, out) {
    const T = r.T;
    let base = r.t0 + Math.floor((t - r.t0) / T) * T, ph = t - base;
    if (ph < 0) { base -= T; ph += T; }
    if (ph >= T) { base += T; ph -= T; }
    if (ph < r.Th) { out.hs = base; out.he = base + r.Th; out.u = r.hi; }
    else { out.hs = base + r.Th; out.he = base + T; out.u = r.lo; }
    for (let g = 0; g < 3 && !(out.he > t); g++) { // 경계 직전 반올림 오차: 다음 반주기로
      if (out.u === r.hi && out.he === base + r.Th) { out.hs = base + r.Th; out.he = base + T; out.u = r.lo; }
      else { base += T; out.hs = base; out.he = base + r.Th; out.u = r.hi; }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Chain : 1차 RC 단의 직렬 연결
  // ------------------------------------------------------------------
  class Chain {
    /** stages: [{type:'LPF'|'HPF', tau:sec}] */
    constructor(stages) {
      stages = stages || [];
      const n = this.n = stages.length;
      this.stages = stages.map(s => ({ type: s.type, tau: s.tau }));
      this.hp = new Uint8Array(n);
      this.a = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        this.hp[i] = stages[i].type === 'HPF' ? 1 : 0;
        let a = 1 / stages[i].tau;
        // 부분분수 전개의 퇴화(동일 극점)를 피하기 위해 아주 미세하게 분리
        for (let g = 0; g < 20; g++) {
          let clash = false;
          for (let k = 0; k < i; k++) if (Math.abs(a - this.a[k]) <= 1e-8 * Math.max(a, this.a[k])) clash = true;
          if (!clash) break;
          a *= 1 + 2e-8;   // ≈√ε : 섭동 오차와 소거 오차의 균형
        }
        this.a[i] = a;
      }
      this.key = this.stages.map(s => s.type + ':' + s.tau).join('|');
      this._sc = new Float64Array(n);
      this._co = this.makeCo();
      this._E = new Float64Array(n);
      this._t1 = new Float64Array(n);
      this._t2 = new Float64Array(n);
    }
    makeCo() {
      const n = this.n;
      return { Y0: 0, Y: new Float64Array(n), S0: new Float64Array(n), S: new Float64Array(n * n) };
    }
    /** 순간 출력: 입력 u, 상태 x */
    output(u, x) {
      let w = u;
      for (let i = 0; i < this.n; i++) w = this.hp[i] ? w - x[i] : x[i];
      return w;
    }
    /** DC 정상상태 (입력 DC 레벨 U) */
    equilibrium(U, x) {
      let w = U;
      for (let i = 0; i < this.n; i++) { x[i] = w; if (this.hp[i]) w = 0; }
    }
    /** DC 이득 (LPF:1, HPF:0) */
    dcGain() { for (let i = 0; i < this.n; i++) if (this.hp[i]) return 0; return 1; }

    /** 상수 입력 u, 초기상태 x 에 대한 구간 계수.
     *  y(τ) = Y0 + Σ Y[k] e^{-a_k τ},  x_i(τ) = S0[i] + Σ S[i,k] e^{-a_k τ} */
    coeffs(u, x, co) {
      const n = this.n, a = this.a, hp = this.hp, S = co.S, sc = this._sc;
      let s0 = u;
      for (let k = 0; k < n; k++) sc[k] = 0;
      for (let i = 0; i < n; i++) {
        const ai = a[i], row = i * n;
        let sum = 0;
        for (let k = 0; k < i; k++) { const c = sc[k] * ai / (ai - a[k]); S[row + k] = c; sum += c; }
        S[row + i] = x[i] - s0 - sum;
        for (let k = i + 1; k < n; k++) S[row + k] = 0;
        co.S0[i] = s0;
        if (hp[i]) { s0 = 0; for (let k = 0; k <= i; k++) sc[k] -= S[row + k]; }
        else { for (let k = 0; k <= i; k++) sc[k] = S[row + k]; }
      }
      co.Y0 = s0;
      for (let k = 0; k < n; k++) co.Y[k] = sc[k];
      return co;
    }
    evalY(co, tau) {
      let y = co.Y0;
      for (let k = 0; k < this.n; k++) y += co.Y[k] * Math.exp(-this.a[k] * tau);
      return y;
    }
    stateFromCo(co, tau, xout) {
      const n = this.n, E = this._E;
      for (let k = 0; k < n; k++) E[k] = Math.exp(-this.a[k] * tau);
      for (let i = 0; i < n; i++) {
        let v = co.S0[i];
        for (let k = 0; k <= i; k++) v += co.S[i * n + k] * E[k];
        xout[i] = v;
      }
    }
    /** 상수 입력 u 로 h 초 진행 (in-place) */
    step(u, x, h) {
      const n = this.n;
      if (n === 0 || !(h > 0)) return;
      if (n === 1) { x[0] = u + (x[0] - u) * Math.exp(-this.a[0] * h); return; }
      const co = this.coeffs(u, x, this._co);
      this.stateFromCo(co, h, x);
    }
    /** PWM 한 주기(High Th → Low T-Th) 사상의 고정점 (주기 시작 시점 상태) */
    pwmFixedPoint(r, xout) {
      const n = this.n;
      if (n === 0) return;
      const f = (xin, out) => { out.set(xin); this.step(r.hi, out, r.Th); this.step(r.lo, out, r.T - r.Th); };
      if (n === 1) {
        const c = new Float64Array(1); f(new Float64Array(1), c);
        xout[0] = c[0] / (-Math.expm1(-this.a[0] * r.T));
        return;
      }
      const zero = new Float64Array(n), c = new Float64Array(n), col = new Float64Array(n), e = new Float64Array(n);
      f(zero, c);
      // A = I - M
      const A = [];
      for (let i = 0; i < n; i++) A.push(new Float64Array(n + 1));
      for (let j = 0; j < n; j++) {
        e.fill(0); e[j] = 1; f(e, col);
        for (let i = 0; i < n; i++) A[i][j] = (i === j ? 1 : 0) - (col[i] - c[i]);
      }
      for (let i = 0; i < n; i++) A[i][n] = c[i];
      // 가우스 소거
      for (let p = 0; p < n; p++) {
        let piv = p;
        for (let i = p + 1; i < n; i++) if (Math.abs(A[i][p]) > Math.abs(A[piv][p])) piv = i;
        const tmp = A[p]; A[p] = A[piv]; A[piv] = tmp;
        const d = A[p][p] || 1e-300;
        for (let i = 0; i < n; i++) {
          if (i === p) continue;
          const m = A[i][p] / d;
          if (m !== 0) for (let j = p; j <= n; j++) A[i][j] -= m * A[p][j];
        }
      }
      for (let i = 0; i < n; i++) xout[i] = A[i][n] / (A[i][i] || 1e-300);
    }
  }

  /** 위상 ph 부터 d 초 동안 PWM 입력으로 진행 */
  function pwmPartial(ch, r, x, ph, d) {
    let guard = 0;
    while (d > 0 && guard++ < 8) {
      if (ph < r.Th) {
        const h = Math.min(d, r.Th - ph);
        ch.step(r.hi, x, h); d -= h; ph += h;
      } else {
        const h = Math.min(d, r.T - ph);
        ch.step(r.lo, x, h); d -= h; ph += h;
        if (ph >= r.T) ph = 0;
      }
    }
  }

  /** PWM 구간 사전계산: 첫 주기 경계 tb, 그 시점 상태 xb, 고정점 xs */
  function prepPWM(bp) {
    if (bp._pwm) return bp._pwm;
    const ch = bp.chain, r = bp.raw, n = ch.n;
    const ph0 = phaseOf(r, bp.t);
    const tb = ph0 === 0 ? bp.t : bp.t + (r.T - ph0);
    const xb = new Float64Array(n); xb.set(bp.x);
    if (ph0 !== 0) pwmPartial(ch, r, xb, ph0, tb - bp.t);
    const xs = new Float64Array(n);
    ch.pwmFixedPoint(r, xs);
    bp._pwm = { ph0: ph0, tb: tb, xb: xb, xs: xs };
    return bp._pwm;
  }

  /** PWM 구간 bp 에서 k번째(경계 tb 기준) 주기 시작 상태 */
  function pwmPeriodState(bp, k, xout) {
    const P = prepPWM(bp), ch = bp.chain, n = ch.n;
    for (let i = 0; i < n; i++) xout[i] = P.xb[i] - P.xs[i];
    if (k > 0) ch.step(0, xout, k * bp.raw.T);
    for (let i = 0; i < n; i++) xout[i] += P.xs[i];
  }

  /** breakpoint bp 기준 시각 t (≥ bp.t) 의 상태 */
  function stateAt(bp, t, xout) {
    const ch = bp.chain, r = bp.raw;
    if (ch.n === 0) return;
    xout.set(bp.x);
    if (!(t > bp.t)) return;
    if (r.k === RAW_CONST) { ch.step(r.v, xout, t - bp.t); return; }
    const P = prepPWM(bp);
    if (t <= P.tb) { pwmPartial(ch, r, xout, P.ph0, t - bp.t); return; }
    let k = Math.floor((t - P.tb) / r.T);
    let rem = (t - P.tb) - k * r.T;
    if (rem < 0) { k--; rem += r.T; }
    if (rem >= r.T) { k++; rem -= r.T; }
    pwmPeriodState(bp, k, xout);
    if (rem > 0) pwmPartial(ch, r, xout, 0, rem);
  }

  // ------------------------------------------------------------------
  // 지수합 y(τ)=Y0+ΣY_k e^{-a_k τ} 의 최소/최대 및 레벨 교차
  // ------------------------------------------------------------------
  function expSumMinMax(ch, co, ta, tb, mm) {
    let y1 = ch.evalY(co, ta), y2 = ch.evalY(co, tb);
    let lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (ch.n === 2) {
      const a1 = ch.a[0], a2 = ch.a[1], Y1 = co.Y[0], Y2 = co.Y[1];
      if (Y1 !== 0) {
        const ratio = -(a2 * Y2) / (a1 * Y1);
        if (ratio > 0) {
          const te = Math.log(ratio) / (a2 - a1);
          if (te > ta && te < tb) { const ye = ch.evalY(co, te); if (ye < lo) lo = ye; if (ye > hi) hi = ye; }
        }
      }
    } else if (ch.n > 2) {
      for (let s = 1; s < 8; s++) { const y = ch.evalY(co, ta + (tb - ta) * s / 8); if (y < lo) lo = y; if (y > hi) hi = y; }
    }
    if (lo < mm.lo) mm.lo = lo;
    if (hi > mm.hi) mm.hi = hi;
  }

  function crosses(a, b, L, rising) { return rising ? (a < L && b >= L) : (a > L && b <= L); }

  /** 단조 구간 [ta,tb] 에서 교차 시각(τ) 탐색 */
  function monoCross(ch, co, ta, tb, L, rising) {
    const ya = ch.evalY(co, ta), yb = ch.evalY(co, tb);
    if (!crosses(ya, yb, L, rising)) return -1;
    if (ch.n === 1 && co.Y[0] !== 0) {
      const q = (L - co.Y0) / co.Y[0];
      if (q > 0) {
        const t = -Math.log(q) / ch.a[0];
        if (t >= ta && t <= tb) return t;
      }
    }
    let lo = ta, hi = tb;
    for (let it = 0; it < 64; it++) {
      const m = 0.5 * (lo + hi);
      const ym = ch.evalY(co, m);
      if (rising ? ym >= L : ym <= L) hi = m; else lo = m;
      if (hi - lo <= 1e-15 * Math.max(1, Math.abs(hi))) break;
    }
    return hi;
  }

  /** 연속 구간 (ta,tb] 에서 첫 교차 τ, 없으면 -1 */
  function expSumCross(ch, co, ta, tb, L, rising) {
    if (ch.n === 0 || !(tb > ta)) return -1;
    if (ch.n === 1) return monoCross(ch, co, ta, tb, L, rising);
    const pts = [ta];
    if (ch.n === 2) {
      const a1 = ch.a[0], a2 = ch.a[1], Y1 = co.Y[0], Y2 = co.Y[1];
      if (Y1 !== 0) {
        const ratio = -(a2 * Y2) / (a1 * Y1);
        if (ratio > 0) { const te = Math.log(ratio) / (a2 - a1); if (te > ta && te < tb) pts.push(te); }
      }
    } else {
      for (let s = 1; s < 16; s++) pts.push(ta + (tb - ta) * s / 16);
    }
    pts.push(tb);
    for (let i = 0; i + 1 < pts.length; i++) {
      const t = monoCross(ch, co, pts[i], pts[i + 1], L, rising);
      if (t >= 0) return t;
    }
    return -1;
  }

  // ------------------------------------------------------------------
  // Timeline : breakpoint 목록 {t, raw, chain, x} — 각 구간 [bp_i.t, bp_{i+1}.t)
  // ------------------------------------------------------------------
  class Timeline {
    constructor() { this.bps = []; this._co = null; }
    get length() { return this.bps.length; }
    last() { return this.bps[this.bps.length - 1]; }
    /** t 이하인 마지막 bp 인덱스 (없으면 -1) */
    find(t) {
      const b = this.bps;
      let lo = 0, hi = b.length - 1, ans = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (b[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return ans;
    }
    /** 새 breakpoint 추가. x 미지정 시 이전 bp 로부터 연속 상태 계산 */
    push(t, raw, chain, x) {
      const b = this.bps;
      const prev = b.length ? b[b.length - 1] : null;
      if (prev && t < prev.t) t = prev.t; // 시간 역행 방지
      const xGiven = !!x;
      if (!x) {
        x = new Float64Array(chain.n);
        if (prev && prev.chain === chain) stateAt(prev, t, x);
        else chain.equilibrium(rawAverage(raw), x);
      }
      if (!xGiven && prev && prev.chain === chain && rawEqual(prev.raw, raw)) return prev;
      const bp = { t: t, raw: raw, chain: chain, x: x, _pwm: null, _co: null };
      if (prev && prev.t === t) b[b.length - 1] = bp; else b.push(bp);
      return bp;
    }
    /** 현재 상태(시각 t) */
    stateAt(t, xout) {
      const i = this.find(t);
      if (i < 0) { xout.fill(0); return null; }
      stateAt(this.bps[i], t, xout);
      return this.bps[i];
    }
    valueAt(t) {
      const i = this.find(t);
      if (i < 0) return 0;
      const bp = this.bps[i];
      const x = new Float64Array(bp.chain.n);
      stateAt(bp, t, x);
      return bp.chain.output(rawRight(bp.raw, t), x);
    }
    /** tKeep 이전의 불필요한 bp 제거 (tKeep 을 포함하는 bp 는 유지) */
    pruneBefore(tKeep) {
      const i = this.find(tKeep);
      if (i > 64 || (i > 0 && i > this.bps.length / 2)) this.bps.splice(0, i);
    }

    // ---------------- 샘플링 ----------------
    _segRange(i, ta, dt, j, N) {
      // bp i 구간에 속하는 샘플 [j, jEnd)
      const b = this.bps;
      if (i + 1 >= b.length) return N;
      const tEnd = b[i + 1].t;
      let jEnd = Math.ceil((tEnd - ta) / dt);
      if (jEnd < j) jEnd = j;
      if (jEnd > N) jEnd = N;
      while (jEnd > j && ta + (jEnd - 1) * dt >= tEnd) jEnd--;
      while (jEnd < N && ta + jEnd * dt < tEnd) jEnd++;
      return jEnd;
    }
    /** Sample 모드: t_j = ta + j*dt 의 값 */
    sample(ta, dt, N, out) {
      const b = this.bps;
      let j = 0;
      if (!b.length) { out.fill(0, 0, N); return; }
      let i = this.find(ta);
      if (i < 0) {
        while (j < N && ta + j * dt < b[0].t) out[j++] = 0;
        i = 0;
      }
      for (; j < N && i < b.length; i++) {
        const jEnd = this._segRange(i, ta, dt, j, N);
        if (jEnd > j) this._fill(b[i], ta, dt, j, jEnd, out);
        j = jEnd;
      }
      for (; j < N; j++) out[j] = 0;
    }
    _fill(bp, ta, dt, j0, j1, out) {
      const ch = bp.chain, r = bp.raw, n = ch.n;
      if (r.k === RAW_CONST) {
        if (n === 0) { out.fill(r.v, j0, j1); return; }
        const co = bp._co || (bp._co = ch.coeffs(r.v, bp.x, ch.makeCo()));
        // 지수 재귀(균일 간격)
        const E = new Float64Array(n), R = new Float64Array(n);
        const tau0 = ta + j0 * dt - bp.t;
        for (let k = 0; k < n; k++) { E[k] = Math.exp(-ch.a[k] * tau0); R[k] = Math.exp(-ch.a[k] * dt); }
        for (let j = j0; j < j1; j++) {
          let y = co.Y0;
          for (let k = 0; k < n; k++) { y += co.Y[k] * E[k]; E[k] *= R[k]; }
          out[j] = y;
        }
        return;
      }
      // PWM
      const T = r.T, Th = r.Th, t0 = r.t0, hi = r.hi, lo = r.lo;
      if (n === 0) {
        for (let j = j0; j < j1; j++) {
          let ph = (ta + j * dt - t0) % T; if (ph < 0) ph += T;
          out[j] = ph < Th ? hi : lo;
        }
        return;
      }
      const co = ch.makeCo(), xs = new Float64Array(n), H = { hs: 0, he: 0, u: 0 };
      let hs = Infinity, he = -Infinity;
      for (let j = j0; j < j1; j++) {
        const t = ta + j * dt;
        if (t < hs || t >= he) {
          halfAt(r, t, H);
          hs = H.hs < bp.t ? bp.t : H.hs; he = H.he;
          stateAt(bp, hs, xs);
          ch.coeffs(H.u, xs, co);
        }
        out[j] = ch.evalY(co, t - hs);
      }
    }

    /** Peak Detect 모드: 구간 [t_j, t_j+dt) 의 최소/최대 */
    samplePeak(ta, dt, N, outMin, outMax) {
      const b = this.bps;
      const mm = { lo: Infinity, hi: -Infinity };
      if (!b.length) { outMin.fill(0, 0, N); outMax.fill(0, 0, N); return; }
      let i = this.find(ta);
      for (let j = 0; j < N; j++) {
        const s = ta + j * dt, e = s + dt;
        mm.lo = Infinity; mm.hi = -Infinity;
        if (i < 0) {
          if (e <= b[0].t) { outMin[j] = 0; outMax[j] = 0; continue; }
          mm.lo = 0; mm.hi = 0; i = 0;
        }
        while (i + 1 < b.length && b[i + 1].t <= s) i++;
        let k = i;
        for (; k < b.length; k++) {
          const bp = b[k];
          const ps = Math.max(s, bp.t), pe = Math.min(e, k + 1 < b.length ? b[k + 1].t : Infinity);
          if (pe > ps) this._rangeMinMax(bp, ps, pe, mm);
          if (k + 1 >= b.length || b[k + 1].t >= e) break;
        }
        outMin[j] = mm.lo; outMax[j] = mm.hi;
      }
    }
    _rangeMinMax(bp, ts, te, mm) {
      const ch = bp.chain, r = bp.raw, n = ch.n;
      if (r.k === RAW_CONST) {
        if (n === 0) { if (r.v < mm.lo) mm.lo = r.v; if (r.v > mm.hi) mm.hi = r.v; return; }
        const co = bp._co || (bp._co = ch.coeffs(r.v, bp.x, ch.makeCo()));
        expSumMinMax(ch, co, ts - bp.t, te - bp.t, mm);
        return;
      }
      const T = r.T, Th = r.Th;
      if (n === 0) {
        const len = te - ts;
        let hasHi = false, hasLo = false;
        if (len >= T) { hasHi = hasLo = true; } else {
          const ph = phaseOf(r, ts), pe = ph + len;
          // [ph, pe) 와 High 구간 [0,Th) ∪ [T, T+Th) 의 교집합
          hasHi = ph < Th || (pe > T);
          hasLo = (pe > Th && ph < T) || pe > T + Th || ph >= Th;
        }
        if (hasHi) { if (r.hi < mm.lo) mm.lo = r.hi; if (r.hi > mm.hi) mm.hi = r.hi; }
        if (hasLo) { if (r.lo < mm.lo) mm.lo = r.lo; if (r.lo > mm.hi) mm.hi = r.lo; }
        return;
      }
      const nHalf = (te - ts) / T * 2;
      const co = ch.makeCo(), x = new Float64Array(n);
      const H = { hs: 0, he: 0, u: 0 };
      const doHalves = (a, b2) => {
        let t = a, guard = 0;
        while (t < b2 && guard++ < 64) {
          halfAt(r, t, H);
          const pe = Math.min(H.he, b2);
          stateAt(bp, t, x);
          ch.coeffs(H.u, x, co);
          expSumMinMax(ch, co, 0, pe - t, mm);
          if (!(pe > t)) break;
          t = pe;
        }
      };
      if (nHalf <= 24) { doHalves(ts, te); return; }
      // 많은 주기: 앞/뒤 2주기 + 중간 표본 주기 평가 (주기 상태는 기하급수적으로 매끄럽게 수렴)
      doHalves(ts, ts + 2 * T);
      doHalves(te - 2 * T, te);
      const pStart = r.t0 + Math.ceil((ts - r.t0) / T) * T;
      const nP = Math.floor((te - pStart) / T);
      for (let s = 1; s <= 8; s++) {
        const pk = pStart + Math.floor(nP * s / 9) * T;
        if (pk > ts && pk + T < te) doHalves(pk, pk + T);
      }
    }

    // ---------------- 트리거 레벨 교차 탐색 ----------------
    /** (tFrom, tTo] 에서 첫 교차 시각, 없으면 -1 */
    findCrossing(tFrom, tTo, L, rising) {
      const b = this.bps;
      if (!b.length || !(tTo > tFrom)) return -1;
      let i = this.find(tFrom);
      let yPrev, tCur = tFrom;
      if (i < 0) { yPrev = 0; i = 0; tCur = Math.min(b[0].t, tTo); if (b[0].t > tTo) return -1; }
      else yPrev = this.valueAt(tFrom);
      const st = { y: yPrev };
      for (; i < b.length; i++) {
        const bp = b[i];
        if (bp.t > tTo) break;
        if (bp.t > tCur || (bp.t === tCur && tCur > tFrom)) {
          const yS = bp.chain.output(rawRight(bp.raw, bp.t), bp.x);
          if (bp.t > tFrom && crosses(st.y, yS, L, rising)) return bp.t;
          st.y = yS;
        }
        const ps = Math.max(bp.t, tFrom);
        const pe = Math.min(i + 1 < b.length ? b[i + 1].t : Infinity, tTo);
        if (pe > ps) {
          const t = this._segCross(bp, ps, pe, L, rising, st);
          if (t >= 0) return t;
        }
        tCur = pe;
        if (pe >= tTo) break;
      }
      return -1;
    }
    _segCross(bp, ts, te, L, rising, st) {
      const ch = bp.chain, r = bp.raw, n = ch.n;
      if (r.k === RAW_CONST) {
        if (n === 0) { st.y = r.v; return -1; }
        const co = bp._co || (bp._co = ch.coeffs(r.v, bp.x, ch.makeCo()));
        const t = expSumCross(ch, co, ts - bp.t, te - bp.t, L, rising);
        if (t >= 0) return bp.t + t;
        st.y = ch.evalY(co, te - bp.t);
        return -1;
      }
      const T = r.T, Th = r.Th, t0 = r.t0;
      if (n === 0) {
        const can = rising ? (r.lo < L && r.hi >= L) : (r.hi > L && r.lo <= L);
        if (can) {
          const off = rising ? 0 : Th;
          let k = Math.floor((ts - t0 - off) / T) + 1;
          let tE = t0 + off + k * T;
          if (tE <= ts) tE += T;
          if (tE - T > ts) tE -= T;
          if (tE <= te) return tE;
        }
        st.y = rawLeft(r, te);
        return -1;
      }
      // 필터가 있는 PWM: 반주기 단위 탐색 + 장구간은 주기 점프 탐색
      const co = ch.makeCo(), x = new Float64Array(n), xe = new Float64Array(n);
      // [a,b] 구간을 반주기 단위로 검사 (x: a 시점 상태, st.y: a 직전 값)
      const H = { hs: 0, he: 0, u: 0 };
      function scanHalves(a, b2, maxHalves) {
        let t = a, cnt = 0;
        stateAt(bp, t, x);
        while (t < b2) {
          halfAt(r, t, H);
          // 반주기 경계에서의 점프 (ts 는 상위 루프에서 이미 처리)
          const yR = ch.output(H.u, x);
          if ((t > a || a !== ts) && crosses(st.y, yR, L, rising)) return { t: t };
          const pe = Math.min(H.he, b2);
          ch.coeffs(H.u, x, co);
          const tc = expSumCross(ch, co, 0, pe - t, L, rising);
          if (tc >= 0) return { t: t + tc };
          st.y = ch.evalY(co, pe - t);
          ch.stateFromCo(co, pe - t, xe); x.set(xe);
          if (!(pe > t)) break;
          t = pe; cnt++;
          if (cnt >= maxHalves && t < b2) return { cont: t };
        }
        return null;
      }
      // 주기 k 의 값 범위 → L 에 대한 관계: -1(아래), +1(위), 0(걸침 → 이 주기 안에서 교차 발생)
      const P = prepPWM(bp);
      const xp = new Float64Array(n), mm = { lo: 0, hi: 0 };
      const relation = (k) => {
        pwmPeriodState(bp, k, xp);
        mm.lo = Infinity; mm.hi = -Infinity;
        ch.coeffs(r.hi, xp, co); expSumMinMax(ch, co, 0, Th, mm);
        ch.stateFromCo(co, Th, xe);
        ch.coeffs(r.lo, xe, co); expSumMinMax(ch, co, 0, T - Th, mm);
        if (rising) return mm.hi < L ? -1 : (mm.lo >= L ? 1 : 0);
        return mm.lo > L ? 1 : (mm.hi <= L ? -1 : 0);
      };
      const setLeftAtPeriod = (k) => { pwmPeriodState(bp, k, xp); st.y = ch.output(r.lo, xp); };
      let t = ts, first = true;
      for (let guard = 0; guard < 100000 && t < te; guard++) {
        const res = scanHalves(t, te, first ? 256 : 64);
        first = false;
        if (!res) return -1;                 // te 까지 교차 없음 (st.y 갱신됨)
        if (res.t !== undefined) return res.t;
        // 다음 주기 경계로 정렬
        let tP = res.cont;
        let kf = (tP - P.tb) / T;
        if (Math.abs(kf - Math.round(kf)) > 1e-6) {
          const r2 = scanHalves(tP, te, 1);
          if (!r2) return -1;
          if (r2.t !== undefined) return r2.t;
          tP = r2.cont; kf = (tP - P.tb) / T;
        }
        const kBase = Math.round(kf);
        const nFull = Math.floor((te - (P.tb + kBase * T)) / T);
        if (nFull < 8) { setLeftAtPeriod(kBase); t = P.tb + kBase * T; continue; }
        // 주기 점프: 관계가 처음 바뀌는 주기를 지수 탐색 + 이분 탐색 (주기 상태는 지수적으로 매끄럽게 변화)
        const r0 = relation(kBase);
        if (r0 === 0) { setLeftAtPeriod(kBase); t = P.tb + kBase * T; continue; }
        let jPrev = 0, j = 1, step = 1, found = -1;
        while (j < nFull) {
          if (relation(kBase + j) !== r0) { found = j; break; }
          jPrev = j; step *= 2; j += step;
          if (j >= nFull && jPrev < nFull - 1) j = nFull - 1;
        }
        let kNext;
        if (found < 0) kNext = kBase + nFull - 1;       // 끝까지 관계 불변 → 마지막 주기만 정밀 탐색
        else {
          let lo = jPrev + 1, hi = found;
          while (lo < hi) { const m = (lo + hi) >> 1; if (relation(kBase + m) !== r0) hi = m; else lo = m + 1; }
          kNext = kBase + Math.max(1, hi - 1);
        }
        setLeftAtPeriod(kNext);
        t = P.tb + kNext * T;
      }
      return -1;
    }
    /** bp 구간 내부 시각 t 의 좌극한 값 */
    leftValueIn(bp, t) {
      const x = new Float64Array(bp.chain.n);
      stateAt(bp, t, x);
      return bp.chain.output(rawLeft(bp.raw, t), x);
    }
  }

  VS.signal = {
    RAW_CONST, RAW_PWM, rawConst, rawPWM, rawEqual, rawAverage, rawRight, rawLeft, phaseOf,
    Chain, Timeline, stateAt, prepPWM, pwmPartial, expSumCross, expSumMinMax
  };
})(typeof window !== 'undefined' ? window : globalThis);
