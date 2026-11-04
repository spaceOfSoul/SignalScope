/* main.js — 앱 구성: 3개의 창, 상단 시뮬레이션 바, 렌더 루프(rAF), 설정 저장/복원, Autoset */
(function (G) {
  'use strict';
  const VS = G.VS, UI = VS.ui, U = VS.util;
  const STATE_KEY = 'vscope.state.v1';

  function merge(dst, src) {
    if (!src || typeof src !== 'object') return dst;
    for (const k of Object.keys(dst)) {
      if (!(k in src)) continue;
      if (dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], src[k]);
      else if (Array.isArray(dst[k]) && Array.isArray(src[k])) dst[k].forEach((v, i) => { if (v && typeof v === 'object') merge(v, src[k][i]); else if (src[k][i] !== undefined) dst[k][i] = src[k][i]; });
      else if (typeof src[k] === typeof dst[k]) dst[k] = src[k];
    }
    return dst;
  }

  class App {
    constructor() {
      const sim = this.sim = new VS.Simulator();
      this.wm = new UI.WindowManager(document.getElementById('desktop'));
      this.pins = new UI.PinsWindow(sim, () => this.saveSoon());
      this.script = new UI.ScriptWindow(sim, this);
      // 창 3: 오실로스코프
      this.canvas = UI.el('canvas');
      const screen = UI.el('div', { class: 'scope-screen' }, UI.el('div', { class: 'bezel' }, this.canvas));
      this.panel = new UI.ScopePanel(sim, this);
      const scopeBody = UI.el('div', { class: 'scope' }, [screen, this.panel.el]);
      this.view = new VS.ScopeView(this.canvas, sim, this);

      this.wm.add('win1', '1', '출력 Pin 설정 및 Probe 배치', this.pins.el);
      this.wm.add('win2', '2', '출력 제어 — Lua 스크립트 · 시뮬레이션 제어', this.script.el);
      this.wm.add('win3', '3', '오실로스코프 (CH1 · CH2)', scopeBody);
      this._buildTopBar();
      this.wm.onVisibility = () => this._syncWinButtons();

      const firstRun = this.load();
      this.wm.restore();
      this.sim.start();
      if (firstRun) {
        setTimeout(() => { this.script.run(); UI.toast('빠른 시작 예제를 실행했습니다. 창 2 에서 스크립트를 편집하고 ▶ 실행하세요.'); }, 300);
      }
      this._loop();
      setInterval(() => { this.pins.live(); this.panel.update(); this._updateTop(); }, 100);
      window.addEventListener('beforeunload', () => this.saveNow());
      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (e.code === 'Space') { e.preventDefault(); this.togglePause(); }
      });
    }

    _buildTopBar() {
      const tb = document.getElementById('topbar');
      tb.innerHTML = '';
      this.winBtns = {};
      const wb = (id, label) => { const b = UI.el('button', { text: label, onclick: () => this.wm.toggle(id) }); this.winBtns[id] = b; return b; };
      this.topPause = UI.el('button', { text: '⏸ Pause', title: '시뮬레이션 일시정지/재개 (Space)', onclick: () => this.togglePause() });
      this.topSpeed = UI.seg([{ v: 0.1, label: '0.1X' }, { v: 1, label: '1X' }, { v: 10, label: '10X' }, { v: 'max', label: 'MAX' }], this.sim.speed, (v) => this.setSpeed(v));
      this.topBadge = UI.el('span', { class: 'badge run', text: 'RUNNING', title: '시뮬레이션 클럭 상태' });
      this.topScript = UI.el('span', { class: 'badge idle', text: 'IDLE', title: '보드 스크립트 상태' });
      this.topClock = UI.el('span', { class: 'simclock' });
      this.topActual = UI.el('span', { class: 'mono dim', style: 'min-width:110px' });
      tb.append(
        UI.el('div', { class: 'brand' }, ['⏚ Oscilloscope Imitation', UI.el('small', { text: 'GPIO · PWM · DAC 계측 시뮬레이터' })]),
        UI.el('div', { class: 'group' }, [wb('win1', '1 · 핀/프로브'), wb('win2', '2 · 스크립트'), wb('win3', '3 · 오실로스코프'),
          UI.el('button', { text: '배치 초기화', title: '창 배치를 기본값으로', onclick: () => this.wm.defaultLayout() })]),
        UI.el('div', { class: 'grow' }),
        UI.el('div', { class: 'group' }, [UI.el('span', { class: 'dim', text: 'Script' }), this.topScript]),
        UI.el('span', { class: 'sep' }),
        UI.el('div', { class: 'group' }, [UI.el('span', { class: 'dim', text: 'Simulation' }), this.topBadge, this.topPause, this.topSpeed.el]),
        UI.el('span', { class: 'sep' }),
        UI.el('div', { class: 'group' }, [this.topClock, this.topActual])
      );
    }
    _syncWinButtons() { for (const id of Object.keys(this.winBtns)) this.winBtns[id].classList.toggle('on', this.wm.isVisible(id)); }
    _updateTop() {
      const sim = this.sim;
      this.topClock.textContent = 't = ' + U.fmtSimTime(sim.simTime);
      const a = sim.actualSpeed;
      this.topActual.textContent = '실속도 ' + (a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2)) + 'x';
      this.topActual.title = '실제 시뮬레이션 속도 (시뮬레이션 시간 / 실제 시간)';
      const rs = sim.runtime.state;
      this.topBadge.textContent = sim.paused ? 'PAUSED' : 'RUNNING';
      this.topBadge.className = 'badge ' + (sim.paused ? 'pause' : 'run');
      this.topScript.textContent = rs.toUpperCase();
      this.topScript.className = 'badge ' + (rs === 'running' ? 'run' : rs === 'error' ? 'err' : 'idle');
      this.topPause.textContent = sim.paused ? '▶ Resume' : '⏸ Pause';
      this.topPause.classList.toggle('on', sim.paused);
      this.topSpeed.set(sim.speed);
      this.script.speedSeg.set(sim.speed);
    }
    _loop() {
      const frame = () => {
        try { this.view.render(); this.script.tick(); } catch (e) { console.error(e); }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    // ---------------- 시뮬레이션 제어 ----------------
    togglePause() { this.sim.setPaused(!this.sim.paused); this.script.updateState(); this._updateTop(); }
    setSpeed(v) { this.sim.setSpeed(v); this._updateTop(); this.saveSoon(); }

    /** 스코프 설정 변경 알림 */
    scopeChanged(kind) {
      if (kind === 'horiz' || kind === 'trig' || kind === 'acq') this.sim.scope.rearm();
      if (kind === 'vert') this.sim.scope.avg = null;
      this.panel.update();
      this.saveSoon();
    }
    scopeDefault() {
      const s = this.sim.scope.s, d = VS.Scope.defaults;
      for (const k of Object.keys(d)) s[k] = d[k];
      for (let c = 0; c < 2; c++) this.sim.setCoupling(c, s.ch[c].coupling);
      this.sim.scope.setRunning(true);
      this.sim.scope.rearm();
      this.panel.update(); this.saveSoon();
      UI.toast('오실로스코프 기본 설정');
    }

    /** 예제 권장 설정 적용 */
    applySetup(st) {
      const sim = this.sim, s = sim.scope.s;
      if (st.probes) { sim.setProbe(0, st.probes[0] || null); sim.setProbe(1, st.probes[1] || null); }
      // 핀 필터/Enable: 명시되지 않은 핀은 기본(사용안함/Enable)
      this.pins.cfg.forEach((c, i) => {
        const f = (st.filters && st.filters[i + 1]) || { type: 'none', R: c.filter.R, C: c.filter.C };
        c.filter = { type: f.type, R: f.R, C: f.C };
        const r = this.pins.rows[i];
        r.fsel.value = f.type; r.rIn.value = U.fmtEng(f.R, ''); r.cIn.value = U.fmtEng(f.C, '').replace('µ', 'u');
        sim.setFilter(i + 1, c.filter);
        if (!c.enabled) { c.enabled = true; r.esel.value = 'en'; sim.setEnabled(i + 1, true); }
      });
      const d = VS.Scope.defaults;
      s.ch.forEach((cs, c) => {
        cs.on = true; cs.vdiv = d.ch[c].vdiv; cs.pos = d.ch[c].pos;
        if (st.ch && st.ch[c]) Object.assign(cs, st.ch[c]);
        if (cs.coupling !== 'DC') sim.setCoupling(c, 'DC');
      });
      if (st.tdiv) s.tdiv = st.tdiv;
      s.delay = 0; s.zoom.on = false; s.zoom.center = 0;
      Object.assign(s.trig, d.trig, st.trig || {});
      s.acq.mode = (st.acq && st.acq.mode) || 'sample';
      sim.scope.setRunning(true);
      sim.scope.rearm();
      this.pins.refresh(); this.panel.update(); this.saveSoon();
    }

    /** AUTOSET: 최근 신호로부터 V/div, Time/div, 트리거 자동 설정 */
    autoset() {
      const sim = this.sim, s = sim.scope.s, t = sim.simTime;
      const span = Math.min(0.25, t);
      if (span < 1e-6) { UI.toast('신호 이력이 부족합니다. 잠시 후 다시 시도하세요.', 'warn'); return; }
      const info = [];
      for (let c = 0; c < 2; c++) {
        if (!sim.probes[c]) { info.push(null); continue; }
        const tl = sim.inputs[c].tl, N = 4000;
        const mn = new Float64Array(N), mx = new Float64Array(N);
        tl.samplePeak(t - span, span / N, N, mn, mx);
        let vmin = Infinity, vmax = -Infinity;
        for (let i = 0; i < N; i++) { if (mn[i] < vmin) vmin = mn[i]; if (mx[i] > vmax) vmax = mx[i]; }
        let period = NaN;
        if (vmax - vmin > 0.02) {
          const mid = (vmin + vmax) / 2, rises = [];
          let tc = t - span;
          for (let k = 0; k < 400; k++) { const r = tl.findCrossing(tc, t, mid, true); if (r < 0) break; rises.push(r); tc = r; }
          if (rises.length >= 3) period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1);
          else if (rises.length === 2) period = rises[1] - rises[0];
        }
        info.push({ vmin: vmin, vmax: vmax, period: period, mid: (vmin + vmax) / 2 });
      }
      const act = info.map((x, c) => x ? c : -1).filter(c => c >= 0);
      if (!act.length) { UI.toast('Probe 가 연결된 채널이 없습니다 (창 1)', 'warn'); return; }
      const target = act.length === 2 ? 3.0 : 6.0;
      for (const c of [0, 1]) {
        const cs = s.ch[c], x = info[c];
        cs.on = !!x;
        if (!x) continue;
        const list = VS.Scope.vdivList(cs.probe);
        const vpp = Math.max(x.vmax - x.vmin, 0.02);
        let vd = list[list.length - 1];
        for (const v of list) if (vpp / v <= target) { vd = v; break; }
        cs.vdiv = vd;
        const centerDiv = act.length === 2 ? (c === act[0] ? 2 : -2) : 0;
        cs.pos = Math.round((centerDiv - x.mid / vd) * 25) / 25;
        if (cs.coupling === 'GND') sim.setCoupling(c, 'DC');
      }
      const src = act.find(c => info[c].period === info[c].period);
      if (src !== undefined) {
        const per = info[src].period;
        const want = 2.5 * per / 10;
        s.tdiv = VS.Scope.TDIV_LIST.find(v => v >= want * 0.999) || s.tdiv;
        s.trig.source = src; s.trig.level = Number(info[src].mid.toPrecision(4));
      } else {
        s.trig.source = act[0]; s.trig.level = Number(info[act[0]].mid.toPrecision(4));
      }
      s.trig.slope = 'rise'; s.trig.mode = 'auto'; s.trig.pos = 0.5;
      s.delay = 0; s.zoom.on = false; s.acq.mode = 'sample';
      sim.scope.setRunning(true); sim.scope.rearm();
      this.view.flashLevel();
      this.panel.update(); this.saveSoon();
      UI.toast('AUTOSET 완료' + (src !== undefined ? ' — 주기 ' + U.fmtEng(info[src].period, 's', 4) : ' (주기 신호 없음)'));
    }

    // ---------------- 저장/복원 ----------------
    saveSoon() { clearTimeout(this._saveT); this._saveT = setTimeout(() => this.saveNow(), 600); }
    saveNow() {
      U.store.set(STATE_KEY, {
        v: 1, pins: this.pins.save(), script: this.script.save(), scope: this.sim.scope.s, scopeRunning: this.sim.scope.running,
        speed: this.sim.speed
      });
      this.wm.save();
    }
    /** @returns 최초 실행 여부 */
    load() {
      const st = U.store.get(STATE_KEY, null);
      if (!st) {
        this.script.load(null);
        this.sim.setProbe(0, 1); this.sim.setProbe(1, 3);  // CH1=GPIO1, CH2=PWM1
        this.pins.refresh();
        return true;
      }
      try {
        this.script.load(st.script);
        this.pins.load(st.pins);
        merge(this.sim.scope.s, st.scope);
        for (let c = 0; c < 2; c++) this.sim.setCoupling(c, this.sim.scope.s.ch[c].coupling);
        if (st.scopeRunning === false) this.sim.scope.setRunning(false);
        if (st.speed !== undefined) this.sim.setSpeed(st.speed);
      } catch (e) { console.error('state restore failed', e); }
      this.pins.refresh(); this.panel.update();
      return false;
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    try { G.app = new App(); }
    catch (e) {
      console.error(e);
      document.body.innerHTML = '<pre style="color:#f88;padding:20px">초기화 오류: ' + U.escapeHtml(e.stack || e) + '</pre>';
    }
  });
})(window);
