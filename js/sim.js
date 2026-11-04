/* sim.js — 시뮬레이션 엔진 (Simulation Clock)
 *
 *  실제 시스템 시간과 독립적인 시뮬레이션 시간(simTime)을 가진다.
 *  - 시뮬레이션 루프(setTimeout 기반, ~4ms)는 GUI 렌더링 루프(requestAnimationFrame)와 독립적으로 동작한다.
 *  - 한 틱의 처리 순서 (모두 동일한 시뮬레이션 클럭 사용):
 *      1) GUI 변경(핀 설정/프로브/커플링/스크립트 시작 등)을 현재 simTime 에 적용
 *      2) 보드 스크립트를 목표 시각 T 까지 실행 (명령어/딜레이 단위 정확한 시각에 출력 이벤트 기록)
 *      3) 이벤트를 핀 필터 → 스코프 입력으로 전달
 *      4) 오실로스코프 획득(트리거 탐색/레코드 생성)을 (simTime, T] 에 대해 수행
 *  - 속도: 0.1X / 1X / 10X / MAX(연산이 허용하는 최대)
 *  - Pause: 보드와 계측기의 가상 시간 자체를 정지 (오실로스코프 Stop 과는 별개)
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const B = VS.board;

  class Simulator {
    constructor() {
      this.board = new B.Board();
      this.vfs = new VS.VFS();
      this.filters = this.board.pins.map(p => new B.PinFilter(p));
      this.inputs = [new B.ScopeInput(0), new B.ScopeInput(1)];
      this.router = new B.SignalRouter(this.board, this.filters, this.inputs);
      this.scope = new VS.Scope(this.inputs);
      this.probes = [null, null];        // CH1/CH2 에 연결된 pin id
      this.simTime = 0;
      this.speed = 1;                    // 0.1 | 1 | 10 | 'max'
      this.paused = false;
      this.actions = [];
      this.actualSpeed = 0;
      this.resetOutputsOnRun = true;
      this.listeners = { console: [], state: [] };
      this._mark = { real: 0, sim: 0 };
      this._timer = null;
      this.tickCount = 0;
      this.lastTickMs = 0;
      const host = {
        print: (text, kind, t) => this._emit('console', { text: text, kind: kind || 'out', t: t }),
        write: (text, t) => this._emit('console', { text: text, kind: 'raw', t: t }),
        onState: (st) => this._emit('state', st)
      };
      this.runtime = new VS.LuaRuntime(this.board, this.vfs, host);
    }
    on(ev, fn) { this.listeners[ev].push(fn); }
    _emit(ev, arg) { for (const f of this.listeners[ev]) { try { f(arg); } catch (e) { console.error(e); } } }

    /** GUI 변경을 시뮬레이션 시간축에 맞춰 적용하기 위한 큐 */
    enqueue(fn) { this.actions.push(fn); }

    // ---------------- GUI → 시뮬레이션 ----------------
    setProbe(ch, pinId) {
      this.probes[ch] = pinId;
      this.enqueue((t) => {
        const inp = this.inputs[ch];
        if (pinId) inp.attach(t, this.board.pin(pinId), this.filters[pinId - 1]); else inp.detach(t);
        this.scope.rearm();
      });
    }
    setFilter(pinId, cfg) {
      this.enqueue((t) => {
        this.filters[pinId - 1].setConfig(t, cfg);
        for (const inp of this.inputs) if (inp.pin && inp.pin.id === pinId) inp.rebuild(t);
        this.scope.avg = null;
      });
    }
    setEnabled(pinId, en) {
      this.enqueue((t) => { this.board.setEnabled(this.board.pin(pinId), en, t); });
    }
    setCoupling(ch, c) {
      this.scope.s.ch[ch].coupling = c;
      this.enqueue((t) => { this.inputs[ch].setCoupling(t, c); this.scope.avg = null; });
    }
    setClock(hz) {
      this.enqueue(() => {
        if (this.runtime.running) { this._emit('console', { text: '스크립트 실행 중에는 보드 클럭을 변경할 수 없습니다.', kind: 'warn', t: this.simTime }); return; }
        this.board.setClock(hz);
      });
    }
    setCPI(cpi) { this.enqueue(() => { this.runtime.setCPI(cpi); }); }
    runScript(source, name) {
      this.enqueue((t) => {
        if (this.resetOutputsOnRun) this.board.resetOutputs(t);
        if (this.runtime.start(source, t, name)) this._emit('console', { text: '▶ script started @ ' + VS.util.fmtSimTime(t), kind: 'info', t: t });
      });
    }
    stopScript() {
      this.enqueue((t) => {
        if (this.runtime.running) { this.runtime.stop('stopped'); this._emit('console', { text: '■ script stopped @ ' + VS.util.fmtSimTime(t), kind: 'info', t: t }); }
      });
    }
    setPaused(p) { this.paused = !!p; this._emit('state', this.runtime.state); }
    setSpeed(sp) { this.speed = sp; this._mark = { real: performance.now(), sim: this.simTime }; }
    resetSimulation() {
      this.enqueue(() => {
        this.runtime.stop(null);
        this.runtime.state = 'idle';
        this.board.hardReset();
        this.simTime = 0;
        const cfgs = this.filters.map(f => f.cfg);
        this.filters = this.board.pins.map((p, i) => { const f = new B.PinFilter(p); f.setConfig(0, cfgs[i]); return f; });
        this.router.filters = this.filters;
        for (let c = 0; c < 2; c++) {
          const inp = new B.ScopeInput(c);
          inp.coupling = this.scope.s.ch[c].coupling;
          this.inputs[c] = inp;
          const pid = this.probes[c];
          if (pid) inp.attach(0, this.board.pin(pid), this.filters[pid - 1]); else inp.rebuild(0);
        }
        this.router.inputs = this.inputs;
        this.scope.inputs = this.inputs;
        this.scope.resetAll();
        this._mark = { real: performance.now(), sim: 0 };
        this._emit('state', 'idle');
        this._emit('console', { text: '⟲ simulation reset (t = 0)', kind: 'info', t: 0 });
      });
    }

    // ---------------- 루프 ----------------
    start() {
      this._last = performance.now();
      this._mark = { real: this._last, sim: this.simTime };
      const loop = () => {
        try { this._tick(); } catch (e) { console.error(e); }
        this._timer = setTimeout(loop, this.speed === 'max' && !this.paused ? 0 : 4);
      };
      loop();
    }
    _applyActions() {
      while (this.actions.length) {
        const fn = this.actions.shift();
        try { fn(this.simTime); } catch (e) { console.error(e); this._emit('console', { text: 'internal: ' + e.message, kind: 'err', t: this.simTime }); }
      }
    }
    _tick() {
      const now = performance.now();
      let dtReal = (now - this._last) / 1000;
      this._last = now;
      if (dtReal > 0.1) dtReal = 0.1;          // 탭 비활성 등으로 인한 큰 점프 방지
      this._applyActions();
      this.tickCount++;
      if (this.paused) { this._measure(now); return; }
      if (this.speed === 'max') {
        // 최대 속도: 실시간 예산(~14ms) 안에서 가능한 만큼 진행.
        // 계측기는 청크당 최대 1개의 레코드를 획득하므로(데드타임), 청크 크기가 클수록 빠르다.
        const deadline = now + 14;
        const chunk = this.scope.maxChunk();
        for (let guard = 0; guard < 400 && performance.now() < deadline; guard++) {
          const before = this.simTime;
          this._chunk(this.simTime + chunk, deadline);
          if (this.simTime === before) break;
        }
      } else {
        this._chunk(this.simTime + dtReal * this.speed, now + 30);
      }
      this.lastTickMs = performance.now() - now;
      this._measure(now);
    }
    _chunk(T, deadline) {
      let tEff = this.runtime.run(T, deadline);
      if (!(tEff >= this.simTime)) tEff = this.simTime;
      if (tEff > T) tEff = T;
      this.router.flush(tEff);
      this.scope.process(this.simTime, tEff);
      this._prune(tEff);
      this.simTime = tEff;
    }
    _prune(t) {
      const keep = this.scope.keepTime(t);
      for (const inp of this.inputs) {
        const tl = inp.tl;
        // 자동설정(Autoset)을 위해 최근 0.25 s 는 가능한 보존 (단, 과도한 이벤트 시 필요한 만큼만)
        const k = tl.length > 200000 ? keep : Math.min(keep, t - 0.25);
        tl.pruneBefore(k);
      }
    }
    _measure(now) {
      const dr = (now - this._mark.real) / 1000;
      if (dr >= 0.5) {
        this.actualSpeed = this.paused ? 0 : (this.simTime - this._mark.sim) / dr;
        this._mark = { real: now, sim: this.simTime };
      }
    }
  }

  VS.Simulator = Simulator;
})(typeof window !== 'undefined' ? window : globalThis);
