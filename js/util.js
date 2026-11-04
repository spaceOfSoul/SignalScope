/* util.js — 공용 유틸리티 (엔지니어링 단위 포맷/파싱, 1-2-5 시퀀스 등) */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const U = VS.util = {};

  const PREFIX = { '-15': 'f', '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', '0': '', '3': 'k', '6': 'M', '9': 'G', '12': 'T' };

  /** 엔지니어링 표기: fmtEng(0.0005,'s') → "500µs" */
  U.fmtEng = function (v, unit, sig, keepZeros) {
    unit = unit || '';
    if (sig === undefined) sig = 3;
    if (!isFinite(v)) return (v > 0 ? '+∞' : v < 0 ? '-∞' : '--') + unit;
    if (v === 0) return '0' + unit;
    const r = Number(Math.abs(v).toPrecision(sig));
    let e3 = Math.floor(Math.log10(r) / 3) * 3;
    if (e3 < -15) e3 = -15;
    if (e3 > 12) e3 = 12;
    let s = (r / Math.pow(10, e3)).toPrecision(sig);
    if (s.indexOf('e') >= 0) s = String(Number(s));
    if (!keepZeros && s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return (v < 0 ? '-' : '') + s + PREFIX[String(e3)] + unit;
  };

  /** 고정 유효숫자(측정값 표기용) */
  U.fmtMeas = function (v, unit) { return U.fmtEng(v, unit, 4, true); };

  /** "10k", "4.7u", "100n", "1.5M", "2.2µ" 등 파싱. 실패 시 NaN */
  U.parseEng = function (str) {
    if (typeof str === 'number') return str;
    // 단위 접미사(Ω, ohm, Hz, F, V, s) 제거
    const s = String(str).trim().replace(/\s+/g, '').replace(/(ohms?|Ω|hz|f|v|s)$/i, '');
    const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)([pnuµμmkKMG]?)$/.exec(s);
    if (!m) return NaN;
    const mult = { '': 1, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[m[2]];
    return parseFloat(m[1]) * mult;
  };

  /** 1-2-5 시퀀스 생성 [min, max] */
  U.seq125 = function (min, max) {
    const out = [];
    let e = Math.floor(Math.log10(min)) - 1;
    for (; ; e++) {
      for (const m of [1, 2, 5]) {
        const v = Number((m * Math.pow(10, e)).toPrecision(6));
        if (v > max * (1 + 1e-9)) return out;
        if (v >= min * (1 - 1e-9)) out.push(v);
      }
    }
  };

  /** 정렬 배열에서 v에 가장 가까운 인덱스 */
  U.nearestIndex = function (arr, v) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(Math.log(arr[i] / v));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  U.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  /** 결정적 PRNG (xorshift128+) + 가우시안 */
  U.Rng = class Rng {
    constructor(seed) { this.s0 = (seed >>> 0) || 0x12345678; this.s1 = 0x9e3779b9; this.spare = null; }
    next() { // [0,1)
      let s1 = this.s0; const s0 = this.s1;
      this.s0 = s0; s1 ^= s1 << 23; s1 ^= s1 >>> 17; s1 ^= s0; s1 ^= s0 >>> 26; this.s1 = s1;
      return ((this.s0 + this.s1) >>> 0) / 4294967296;
    }
    gauss() {
      if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
      let u, v, s;
      do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      this.spare = v * m; return u * m;
    }
  };

  /** localStorage 안전 래퍼 */
  U.store = {
    get(key, def) { try { const s = G.localStorage.getItem(key); return s == null ? def : JSON.parse(s); } catch (e) { return def; } },
    set(key, val) { try { G.localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },
    del(key) { try { G.localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  };

  U.escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  /** 시뮬레이션 시간 표기 (s 단위) */
  U.fmtSimTime = function (t) {
    if (t < 1e-3) return (t * 1e6).toFixed(3) + ' µs';
    if (t < 1) return (t * 1e3).toFixed(4) + ' ms';
    if (t < 60) return t.toFixed(6) + ' s';
    const m = Math.floor(t / 60);
    return m + ' m ' + (t - m * 60).toFixed(4) + ' s';
  };
})(typeof window !== 'undefined' ? window : globalThis);
