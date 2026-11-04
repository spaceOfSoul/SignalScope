/* board.js — 가상 보드(출력 핀/레지스터/클럭), 핀 필터 단, 오실로스코프 입력 프런트엔드
 *
 *  [보드 출력 핀] --raw 이벤트--> [PinFilter (R-C LPF / C-R HPF)] --> 프로브 --> [ScopeInput (DC/AC/GND 커플링)] --> ADC
 *
 *  - 핀 출력은 레지스터 값으로부터 결정되는 raw 신호 기술자(상수 / PWM)이며, 변경 시점(보드 클럭에 정렬)에
 *    이벤트로 큐에 쌓인다.
 *  - PinFilter 는 핀과 프로브 사이의 독립적인 신호처리 단으로, 프로브 연결 여부와 무관하게 자체 상태를 유지한다.
 *  - ScopeInput 은 연결된 핀(필터 포함)과 채널 커플링을 하나의 체인으로 묶어 Timeline 을 만든다.
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const S = VS.signal;

  const PIN_DEFS = [
    { id: 1, name: 'GPIO1', kind: 'gpio' },
    { id: 2, name: 'GPIO2', kind: 'gpio' },
    { id: 3, name: 'PWM1', kind: 'pwm' },
    { id: 4, name: 'PWM2', kind: 'pwm' },
    { id: 5, name: 'DAC1', kind: 'dac' },
    { id: 6, name: 'DAC2', kind: 'dac' }
  ];

  // ------------------------------------------------------------------
  class Pin {
    constructor(def, board) {
      this.id = def.id; this.name = def.name; this.kind = def.kind; this.board = board;
      this.enabled = true;
      this.queue = []; this.qHead = 0;
      this.lastT = 0;
      this.resetRegs();
      this.raw = this.computeRaw();
    }
    resetRegs() {
      this.level = 0;           // GPIO 출력 레지스터
      this.pwmOn = false;       // PWM 동작 여부
      this.pwmFreqReq = 1000;   // 요청 주파수
      this.pwmDutyReq = 50;     // 요청 듀티(%)
      this.pwmPeriodTicks = 0;  // 실제 주기(클럭 tick)
      this.pwmHighTicks = 0;    // 실제 High 시간(tick)
      this.pwmT0 = 0;           // 카운터 원점 시각
      this.dacCode = 0;
      this._recalcPWM();
    }
    _recalcPWM() {
      const clk = this.board.clk;
      const per = Math.max(2, Math.min(4294967295, Math.round(clk / Math.max(1e-6, this.pwmFreqReq))));
      this.pwmPeriodTicks = per;
      this.pwmHighTicks = Math.max(0, Math.min(per, Math.round(per * this.pwmDutyReq / 100)));
    }
    get pwmFreq() { return this.board.clk / this.pwmPeriodTicks; }
    get pwmDuty() { return 100 * this.pwmHighTicks / this.pwmPeriodTicks; }
    get dacVoltage() { return this.dacCode / this.board.dacMax * this.board.vref; }
    computeRaw() {
      const b = this.board;
      if (!this.enabled) return S.rawConst(0);
      if (this.kind === 'dac') return S.rawConst(this.dacVoltage);
      if (this.kind === 'pwm' && this.pwmOn) {
        const T = this.pwmPeriodTicks / b.clk, Th = this.pwmHighTicks / b.clk;
        return S.rawPWM(this.pwmT0, T, Th, b.voh, 0);
      }
      return S.rawConst(this.level ? b.voh : 0);
    }
    /** 레지스터 변경 후 출력 갱신 → 이벤트 */
    emit(t) {
      if (t < this.lastT) t = this.lastT;
      const raw = this.computeRaw();
      if (S.rawEqual(raw, this.raw)) return;
      this.raw = raw;
      this.lastT = t;
      this.queue.push({ t: t, raw: raw });
      this.board.eventCount++;
    }
    /** 시각 t 의 출력 전압 (실제 출력 = 레지스터 기반) */
    voltageAt(t) { return S.rawRight(this.raw, t); }
    /** 시각 t 의 논리 레벨 (PWM 동작 중이면 순간 레벨) */
    levelAt(t) {
      if (!this.enabled) return 0;
      if (this.kind === 'pwm' && this.pwmOn) return S.rawRight(this.raw, t) > this.board.voh / 2 ? 1 : 0;
      return this.level ? 1 : 0;
    }
    describe() {
      if (!this.enabled) return 'Hi-Z (disabled)';
      if (this.kind === 'dac') return this.dacVoltage.toFixed(3) + ' V (' + this.dacCode + ')';
      if (this.kind === 'pwm' && this.pwmOn)
        return 'PWM ' + VS.util.fmtEng(this.pwmFreq, 'Hz', 4) + ' ' + this.pwmDuty.toFixed(1) + '%';
      return this.level ? 'HIGH' : 'LOW';
    }
  }

  // ------------------------------------------------------------------
  class Board {
    constructor() {
      this.clk = 10e6;          // 보드 시스템 클럭 (Hz)
      this.voh = 3.3;           // 디지털 High 전압
      this.vref = 3.3;          // DAC 기준전압
      this.dacBits = 12;
      this.dacMax = (1 << this.dacBits) - 1;
      this.eventCount = 0;
      this.pins = PIN_DEFS.map(d => new Pin(d, this));
      this.byName = {};
      for (const p of this.pins) this.byName[p.name] = p;
    }
    pin(id) { return this.pins[id - 1]; }
    /** t 이상인 가장 가까운 클럭 엣지 */
    quantizeUp(t) {
      const k = Math.ceil(t * this.clk - 1e-6);
      return k / this.clk;
    }
    setClock(hz) {
      this.clk = hz;
      for (const p of this.pins) p._recalcPWM();
    }
    // ---- 레지스터 쓰기 (시각 t: 보드 시뮬레이션 시간) ----
    gpioWrite(p, v, t) {
      if (p.kind === 'dac') throw new Error(p.name + ' is a DAC pin (use dac_write)');
      p.level = v ? 1 : 0;
      if (p.kind === 'pwm') p.pwmOn = false;
      p.emit(t);
    }
    gpioToggle(p, t) {
      if (p.kind === 'dac') throw new Error(p.name + ' is a DAC pin');
      const cur = p.kind === 'pwm' && p.pwmOn ? p.levelAt(t) : p.level;
      this.gpioWrite(p, cur ? 0 : 1, t);
    }
    pwmConfig(p, freq, duty, start, t) {
      if (p.kind !== 'pwm') throw new Error(p.name + ' does not support PWM (use PWM1/PWM2)');
      if (freq !== null && freq !== undefined) {
        if (!(freq > 0)) throw new Error('PWM frequency must be > 0');
        p.pwmFreqReq = Math.min(freq, this.clk / 2);
      }
      if (duty !== null && duty !== undefined) p.pwmDutyReq = Math.max(0, Math.min(100, duty));
      const oldPer = p.pwmPeriodTicks, wasOn = p.pwmOn;
      p._recalcPWM();
      if (start && !wasOn) {
        p.pwmOn = true; p.pwmT0 = t;     // 카운터 시작
      } else if (wasOn && oldPer !== p.pwmPeriodTicks) {
        // 카운터는 계속 진행: 현재 카운트가 새 주기보다 작으면 위상 유지, 아니면 리셋
        const elapsed = Math.round((t - p.pwmT0) * this.clk);
        const c = ((elapsed % oldPer) + oldPer) % oldPer;
        p.pwmT0 = c < p.pwmPeriodTicks ? t - c / this.clk : t;
      }
      p.emit(t);
    }
    pwmStop(p, level, t) {
      if (p.kind !== 'pwm') throw new Error(p.name + ' does not support PWM');
      p.pwmOn = false; p.level = level ? 1 : 0;
      p.emit(t);
    }
    dacWrite(p, code, t) {
      if (p.kind !== 'dac') throw new Error(p.name + ' is not a DAC pin (use DAC1/DAC2)');
      p.dacCode = Math.max(0, Math.min(this.dacMax, Math.round(code)));
      p.emit(t);
    }
    setEnabled(p, en, t) { p.enabled = !!en; p.emit(t); }
    resetOutputs(t) { for (const p of this.pins) { p.resetRegs(); p.emit(t); } }
    hardReset() {
      for (const p of this.pins) { p.resetRegs(); p.queue = []; p.qHead = 0; p.lastT = 0; p.raw = p.computeRaw(); }
      this.eventCount = 0;
    }
  }

  // ------------------------------------------------------------------
  // 체인 캐시: 동일 구성은 동일 Chain 객체 (Timeline 중복제거에 사용)
  const chainCache = new Map();
  function getChain(stages) {
    const key = stages.map(s => s.type + ':' + s.tau).join('|');
    let c = chainCache.get(key);
    if (!c) { c = new S.Chain(stages); chainCache.set(key, c); if (chainCache.size > 256) chainCache.clear(); }
    return c;
  }

  /** 핀 필터: 출력 핀과 프로브 사이의 독립적인 신호처리 단 (R-C LPF / C-R HPF) */
  class PinFilter {
    constructor(pin) {
      this.pin = pin;
      this.cfg = { type: 'none', R: 1000, C: 100e-9 };
      this.chain = getChain([]);
      this.bp = { t: 0, raw: pin.raw, chain: this.chain, x: new Float64Array(0), _pwm: null, _co: null };
    }
    static stagesOf(cfg) {
      if (!cfg || cfg.type === 'none') return [];
      return [{ type: cfg.type, tau: Math.max(1e-12, cfg.R * cfg.C) }];
    }
    stages() { return PinFilter.stagesOf(this.cfg); }
    get tau() { return this.cfg.R * this.cfg.C; }
    get fc() { return 1 / (2 * Math.PI * this.cfg.R * this.cfg.C); }
    advanceTo(t) {
      const bp = this.bp;
      if (!(t > bp.t)) return;
      const x = new Float64Array(bp.chain.n);
      S.stateAt(bp, t, x);
      this.bp = { t: t, raw: bp.raw, chain: bp.chain, x: x, _pwm: null, _co: null };
    }
    onRaw(t, raw) {
      this.advanceTo(t);
      const bp = this.bp;
      this.bp = { t: Math.max(t, bp.t), raw: raw, chain: bp.chain, x: bp.x, _pwm: null, _co: null };
    }
    setConfig(t, cfg) {
      this.advanceTo(t);
      this.cfg = { type: cfg.type, R: cfg.R, C: cfg.C };
      this.chain = getChain(this.stages());
      const x = new Float64Array(this.chain.n);
      this.chain.equilibrium(S.rawAverage(this.bp.raw), x); // 새 필터는 현재 입력의 DC 정상상태에서 시작
      this.bp = { t: Math.max(t, this.bp.t), raw: this.bp.raw, chain: this.chain, x: x, _pwm: null, _co: null };
    }
    /** 시각 t 의 필터 상태 */
    stateAt(t) {
      const x = new Float64Array(this.bp.chain.n);
      S.stateAt(this.bp, Math.max(t, this.bp.t), x);
      return x;
    }
    /** 필터 출력(프로브 지점) 전압 */
    outputAt(t) {
      const x = this.stateAt(t);
      return this.bp.chain.output(S.rawRight(this.bp.raw, t), x);
    }
  }

  const AC_FC = 10; // AC 커플링 차단주파수 (Hz)
  const TAU_AC = 1 / (2 * Math.PI * AC_FC);

  /** 오실로스코프 채널 입력 프런트엔드 */
  class ScopeInput {
    constructor(index) {
      this.index = index;
      this.tl = new S.Timeline();
      this.pin = null; this.filter = null;
      this.coupling = 'DC';
      this.hasAC = false;
      this.chain = getChain([]);
      this.tl.push(0, S.rawConst(0), this.chain, new Float64Array(0));
    }
    attach(t, pin, filter) { this.pin = pin; this.filter = filter; this.rebuild(t); }
    detach(t) { this.pin = null; this.filter = null; this.rebuild(t); }
    setCoupling(t, c) { this.coupling = c; this.rebuild(t); }
    /** 구성 변경 시 새 체인/상태로 breakpoint 추가 */
    rebuild(t) {
      const last = this.tl.last();
      if (t < last.t) t = last.t;
      const prevX = new Float64Array(last.chain.n);
      S.stateAt(last, t, prevX);
      const connected = this.pin && this.coupling !== 'GND';
      const pinStages = connected ? this.filter.stages() : [];
      const ac = this.coupling === 'AC';
      const stages = pinStages.concat(ac ? [{ type: 'HPF', tau: TAU_AC }] : []);
      const chain = getChain(stages);
      const raw = connected ? this.filter.bp.raw : S.rawConst(0);
      const x = new Float64Array(chain.n);
      if (pinStages.length) x.set(this.filter.stateAt(t), 0);
      if (ac) {
        if (this.hasAC && prevX.length) x[chain.n - 1] = prevX[prevX.length - 1];     // 커플링 커패시터 전하 유지
        else {
          // 새로 AC 로 전환: 입력 DC 레벨에서 시작(정착 상태)
          const g = connected ? getChain(pinStages).dcGain() : 1;
          x[chain.n - 1] = g * S.rawAverage(raw);
        }
      }
      this.hasAC = ac;
      this.chain = chain;
      this.tl.push(t, raw, chain, x);
    }
    onRaw(t, raw) {
      if (!this.pin || this.coupling === 'GND') return;
      this.tl.push(t, raw, this.chain);
    }
    get label() { return this.pin ? this.pin.name : '—'; }
  }

  /** 핀 이벤트 큐 → PinFilter, 연결된 ScopeInput 으로 전달 */
  class SignalRouter {
    constructor(board, filters, inputs) { this.board = board; this.filters = filters; this.inputs = inputs; }
    flush(tEff) {
      for (const p of this.board.pins) {
        const q = p.queue, f = this.filters[p.id - 1];
        while (p.qHead < q.length && q[p.qHead].t <= tEff) {
          const ev = q[p.qHead++];
          f.onRaw(ev.t, ev.raw);
          for (const inp of this.inputs) if (inp.pin === p) inp.onRaw(ev.t, ev.raw);
        }
        if (p.qHead > 0 && (p.qHead === q.length || p.qHead > 4096)) { q.splice(0, p.qHead); p.qHead = 0; }
        f.advanceTo(tEff);
      }
    }
  }

  VS.board = { PIN_DEFS, Pin, Board, PinFilter, ScopeInput, SignalRouter, getChain, TAU_AC, AC_FC };
})(typeof window !== 'undefined' ? window : globalThis);
