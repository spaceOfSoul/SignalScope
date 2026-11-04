/* ui_scope.js — 창 3: 오실로스코프 전면 패널 (Vertical / Horizontal / Trigger / Acquire / Display) */
(function (G) {
  'use strict';
  const VS = G.VS, UI = VS.ui, U = VS.util;
  const SC = VS.Scope;
  const CH_COL = ['#ffd400', '#1fd6e8'];

  class ScopePanel {
    constructor(sim, app) {
      this.sim = sim; this.app = app;
      this.el = UI.el('div', { class: 'scope-panel' });
      this.k = {}; this.segs = {};
      this._build();
    }
    get s() { return this.sim.scope.s; }
    get scope() { return this.sim.scope; }
    ch(key) { this.app.scopeChanged(key); this.update(); }

    _sec(title, extra) {
      const sec = UI.el('div', { class: 'sp-sec' }, [UI.el('h5', null, [title].concat(extra || []))]);
      this.el.appendChild(sec);
      return sec;
    }
    _row(label, items) { return UI.el('div', { class: 'sp-row' }, [label ? UI.el('span', { class: 'lbl', text: label }) : null].concat(items)); }

    _build() {
      const sim = this.sim;
      // ---------- 실행 제어 ----------
      this.bRun = UI.el('button', { id: 'btnRun', text: 'RUN', title: 'Run/Stop: 획득 시작/중지 (Stop 은 계측기 획득만 중단, 보드 시뮬레이션은 계속)', onclick: () => { this.scope.setRunning(!this.scope.running); if (this.s.trig.mode === 'single' && this.scope.running) this.scope.avg = null; this.update(); this.app.saveSoon(); } });
      this.bSingle = UI.el('button', { id: 'btnSingle', text: 'SINGLE', title: 'Single: 트리거 1회 만족 시 획득 후 정지', onclick: () => { this.scope.single(); this.update(); this.app.saveSoon(); } });
      const bAuto = UI.el('button', { text: 'AUTOSET', title: '연결된 신호에 맞춰 V/div, Time/div, 트리거를 자동 설정', onclick: () => this.app.autoset() });
      const bForce = UI.el('button', { text: 'FORCE', title: '강제 트리거', onclick: () => this.scope.forceTrigger() });
      const bDef = UI.el('button', { text: 'DEFAULT', title: '스코프 기본 설정으로 초기화', onclick: () => this.app.scopeDefault() });
      const bClr = UI.el('button', { text: 'CLEAR', title: '화면/평균 버퍼 지우기', onclick: () => { this.scope.record = null; this.scope.avg = null; this.scope.rollState = null; } });
      this.el.appendChild(UI.el('div', { class: 'runbtns' }, [this.bRun, this.bSingle, bAuto, bForce, bDef, bClr]));

      // ---------- VERTICAL ----------
      const vsec = this._sec('Vertical');
      const cols = UI.el('div', { class: 'sp-cols' });
      vsec.appendChild(cols);
      this.chUI = [];
      for (let c = 0; c < 2; c++) {
        const col = UI.el('div', { class: 'c' + (c + 1) });
        const btn = UI.el('button', { class: 'chbtn c' + (c + 1), text: 'CH' + (c + 1), title: '채널 표시 ON/OFF', onclick: () => { this.s.ch[c].on = !this.s.ch[c].on; this.ch('vert'); } });
        const pin = UI.el('div', { class: 'hint', style: 'text-align:center;font-family:var(--mono);margin:2px 0' });
        const kv = new UI.Knob({
          label: 'Volts/div', color: CH_COL[c], onStep: (d) => {
            const list = SC.vdivList(this.s.ch[c].probe);
            const i = U.clamp(U.nearestIndex(list, this.s.ch[c].vdiv) - d, 0, list.length - 1);   // 시계방향 = 감도↑(V/div 작게)
            this.s.ch[c].vdiv = list[i]; this.ch('vert');
          }, onReset: () => { this.s.ch[c].vdiv = this.s.ch[c].probe; this.ch('vert'); }
        });
        const kp = new UI.Knob({
          label: 'Position', color: CH_COL[c], onStep: (d, fine) => {
            this.s.ch[c].pos = U.clamp(Math.round((this.s.ch[c].pos + d * (fine ? 0.04 : 0.2)) * 25) / 25, -8, 8); this.ch('vert');
          }, onReset: () => { this.s.ch[c].pos = 0; this.ch('vert'); }
        });
        const cpl = UI.seg([{ v: 'DC', label: 'DC', title: 'DC 커플링: DC 성분 포함' }, { v: 'AC', label: 'AC', title: 'AC 커플링: DC 성분 제거 (HPF ≈10 Hz)' }, { v: 'GND', label: 'GND', title: '입력 접지 (0 V 기준 확인)' }],
          this.s.ch[c].coupling, (v) => { this.sim.setCoupling(c, v); this.ch('vert'); });
        const prb = UI.seg([{ v: 1, label: '1X' }, { v: 10, label: '10X' }], this.s.ch[c].probe, (v) => {
          const cs = this.s.ch[c];
          cs.probe = v;
          const list = SC.vdivList(v);
          cs.vdiv = list[U.nearestIndex(list, cs.vdiv)];
          this.ch('vert');
        });
        col.append(btn, pin, UI.el('div', { class: 'sp-knobs' }, [kv.el, kp.el]),
          UI.el('div', { class: 'sp-row', style: 'justify-content:center' }, [cpl.el]),
          UI.el('div', { class: 'sp-row', style: 'justify-content:center' }, [UI.el('span', { class: 'hint', text: 'Probe' }), prb.el]));
        cols.appendChild(col);
        this.chUI.push({ btn: btn, pin: pin, kv: kv, kp: kp, cpl: cpl, prb: prb });
      }

      // ---------- HORIZONTAL ----------
      const hsec = this._sec('Horizontal');
      this.k.tdiv = new UI.Knob({
        label: 'Time/div', onStep: (d) => {
          const L = SC.TDIV_LIST, i = U.clamp(U.nearestIndex(L, this.s.tdiv) - d, 0, L.length - 1);
          this.s.tdiv = L[i]; this.ch('horiz');
        }, onReset: () => { this.s.tdiv = 1e-3; this.ch('horiz'); }
      });
      this.k.hpos = new UI.Knob({
        label: 'Position', title: 'Horizontal Position (트리거 기준 지연)', onStep: (d, fine) => {
          const st = this.s.tdiv / (fine ? 50 : 5);
          this.s.delay = Math.round((this.s.delay + d * st) / st) * st;
          if (Math.abs(this.s.delay) < st * 1e-6) this.s.delay = 0;
          this.ch('horiz');
        }, onReset: () => { this.s.delay = 0; this.ch('horiz'); }
      });
      this.k.zoom = new UI.Knob({ label: 'Zoom ×', title: 'Zoom 배율 (화면 휠과 동일)', onStep: (d) => { this.app.view.zoomStep(d); this.update(); }, onReset: () => { this.s.zoom.on = false; this.ch('zoom'); } });
      this.k.zpos = new UI.Knob({
        label: 'Zoom Pos', onStep: (d, fine) => {
          const zW = this.s.tdiv * 10 / this.s.zoom.factor;
          this.s.zoom.center += d * zW / (fine ? 50 : 10); this.ch('zoom');
        }, onReset: () => { this.s.zoom.center = 0; this.ch('zoom'); }
      });
      hsec.appendChild(UI.el('div', { class: 'sp-knobs' }, [this.k.tdiv.el, this.k.hpos.el, this.k.zoom.el, this.k.zpos.el]));
      this.bZoom = UI.el('button', { text: 'Zoom', onclick: () => { this.s.zoom.on = !this.s.zoom.on; if (this.s.zoom.on && this.s.zoom.factor < 2) this.s.zoom.factor = 5; this.ch('zoom'); } });
      this.bRoll = UI.el('button', { text: 'Roll', title: 'Auto 트리거 + 100 ms/div 이상에서 Roll(스크롤) 모드', onclick: () => { this.s.roll = !this.s.roll; this.ch('horiz'); } });
      hsec.appendChild(this._row('', [this.bZoom, this.bRoll,
        UI.el('button', { text: 'Pos → 0', onclick: () => { this.s.delay = 0; this.ch('horiz'); } }),
        UI.el('button', { text: 'Zoom Pos → 0', onclick: () => { this.s.zoom.center = 0; this.ch('zoom'); } })]));

      // ---------- TRIGGER ----------
      const tsec = this._sec('Trigger');
      this.k.lvl = new UI.Knob({
        label: 'Level', color: '#ff9a3c', onStep: (d, fine) => {
          const cs = this.s.ch[this.s.trig.source];
          const st = cs.vdiv / (fine ? 25 : 5);
          this.s.trig.level = Number((Math.round(this.s.trig.level / st + d) * st).toPrecision(6));
          this.app.view.flashLevel(); this.ch('trig');
        }, onReset: () => this.set50()
      });
      this.k.tpos = new UI.Knob({
        label: 'Pre-Trigger', color: '#ff9a3c', title: 'Trigger Position: 레코드 내 트리거 이전(Pre) 비율', onStep: (d, fine) => {
          this.s.trig.pos = U.clamp(Math.round(this.s.trig.pos * 100 + d * (fine ? 1 : 5)) / 100, 0, 1); this.ch('trig');
        }, onReset: () => { this.s.trig.pos = 0.5; this.ch('trig'); }
      });
      tsec.appendChild(UI.el('div', { class: 'sp-knobs' }, [this.k.lvl.el, this.k.tpos.el,
        UI.el('div', { style: 'display:flex;flex-direction:column;gap:4px;justify-content:center' }, [
          UI.el('button', { text: '50 %', title: '트리거 레벨을 소스 신호의 중간값으로', onclick: () => this.set50() }),
          UI.el('button', { text: 'Pre 50%', onclick: () => { this.s.trig.pos = 0.5; this.ch('trig'); } })])]));
      this.segs.tmode = UI.seg([{ v: 'auto', label: 'Auto', title: '트리거가 없어도 일정 시간 후 파형 표시' }, { v: 'normal', label: 'Normal', title: '트리거 조건 충족 시에만 갱신' }, { v: 'single', label: 'Single', title: '1회 획득 후 정지' }],
        this.s.trig.mode, (v) => { this.s.trig.mode = v; if (v === 'single') this.scope.single(); this.ch('trig'); });
      this.segs.tsrc = UI.seg([{ v: 0, label: 'CH1' }, { v: 1, label: 'CH2' }], this.s.trig.source, (v) => { this.s.trig.source = v; this.ch('trig'); });
      this.segs.tslope = UI.seg([{ v: 'rise', label: '↑ Rising' }, { v: 'fall', label: '↓ Falling' }], this.s.trig.slope, (v) => { this.s.trig.slope = v; this.ch('trig'); });
      tsec.append(this._row('Mode', [this.segs.tmode.el]), this._row('Source', [this.segs.tsrc.el, UI.el('span', { class: 'hint', text: 'Edge' })]), this._row('Slope', [this.segs.tslope.el]));

      // ---------- ACQUIRE ----------
      const asec = this._sec('Acquire');
      this.segs.amode = UI.seg([{ v: 'sample', label: 'Sample' }, { v: 'peak', label: 'Peak Det', title: '샘플 간격 내 최소/최대 보존 (짧은 펄스 표시)' }, { v: 'average', label: 'Average' }],
        this.s.acq.mode, (v) => { this.s.acq.mode = v; this.scope.avg = null; this.ch('acq'); });
      this.avgSel = UI.select(SC.AVG_LIST.map(v => ({ v: v, label: v + '회' })), this.s.acq.avgN, (v) => { this.s.acq.avgN = +v; this.scope.avg = null; this.ch('acq'); }, { title: '평균 횟수' });
      this.segs.rl = UI.seg(SC.RL_LIST.map(v => ({ v: v, label: U.fmtEng(v, '') })), this.s.acq.rl, (v) => { this.s.acq.rl = v; this.s.acq.srMode = 'auto'; this.ch('acq'); });
      this.segs.srm = UI.seg([{ v: 'auto', label: 'Auto (RL 우선)' }, { v: 'manual', label: 'Manual (SR 우선)' }], this.s.acq.srMode, (v) => {
        if (v === 'manual') this.s.acq.sr = SC.SR_LIST[U.nearestIndex(SC.SR_LIST, this.scope.horiz().fs)];
        this.s.acq.srMode = v; this.ch('acq');
      });
      this.srSel = UI.select(SC.SR_LIST.map(v => ({ v: v, label: U.fmtEng(v, 'Sa/s') })), this.s.acq.sr, (v) => { this.s.acq.sr = +v; this.s.acq.srMode = 'manual'; this.ch('acq'); }, { title: 'Sample Rate (Manual)' });
      this.acqInfo = UI.el('div', { class: 'acqinfo' });
      asec.append(this._row('Mode', [this.segs.amode.el]), this._row('Average', [this.avgSel]), this._row('Record', [this.segs.rl.el]),
        this._row('Rate', [this.segs.srm.el]), this._row('', [this.srSel]), this.acqInfo);

      // ---------- DISPLAY ----------
      const dsec = this._sec('Display / Utility');
      this.segs.vec = UI.seg([{ v: true, label: 'Vectors' }, { v: false, label: 'Dots' }], this.s.display.vectors, (v) => { this.s.display.vectors = v; this.ch('disp'); });
      this.segs.noise = UI.seg([{ v: true, label: 'On' }, { v: false, label: 'Off' }], this.s.display.noise, (v) => { this.s.display.noise = v; this.ch('disp'); });
      this.segs.meas = UI.seg([{ v: true, label: 'On' }, { v: false, label: 'Off' }], this.s.display.measure, (v) => { this.s.display.measure = v; this.ch('disp'); });
      dsec.append(this._row('Draw', [this.segs.vec.el]), this._row('Noise', [this.segs.noise.el, UI.el('span', { class: 'hint', text: 'ADC 입력 잡음' })]), this._row('Measure', [this.segs.meas.el]));
      dsec.appendChild(UI.el('div', { class: 'hint', style: 'margin-top:4px', html: '화면 조작: <b>휠</b>=Zoom · <b>드래그</b>=수평 위치/Zoom 위치 · 우측 <b>T</b> 마커 드래그=트리거 레벨 · 좌측 채널 마커 드래그=수직 위치 · Zoom 창 더블클릭=Zoom 해제' }));
      this.update();
    }

    set50() {
      const rec = this.scope.record, c = this.s.trig.source;
      let lvl = null;
      if (rec && rec.ch[c]) {
        const m = VS.scopeMeasure(rec, c, -Infinity, Infinity);
        if (m) lvl = (m.vmax + m.vmin) / 2;
      }
      if (lvl === null) {
        const tl = this.sim.inputs[c].tl, t = this.sim.simTime, span = Math.min(0.05, t);
        if (span > 0) { const N = 500, mn = new Float64Array(N), mx = new Float64Array(N); tl.samplePeak(t - span, span / N, N, mn, mx); lvl = (Math.min.apply(null, mn) + Math.max.apply(null, mx)) / 2; }
      }
      if (lvl !== null && isFinite(lvl)) { this.s.trig.level = Number(lvl.toPrecision(4)); this.app.view.flashLevel(); this.ch('trig'); }
    }

    update() {
      const s = this.s, sc = this.scope;
      this.bRun.textContent = sc.running ? 'RUN' : 'STOP';
      this.bRun.className = sc.running ? 'running' : 'stopped';
      this.bSingle.classList.toggle('armed', s.trig.mode === 'single' && sc.running);
      for (let c = 0; c < 2; c++) {
        const u = this.chUI[c], cs = s.ch[c];
        u.btn.classList.toggle('on', cs.on);
        u.btn.textContent = 'CH' + (c + 1) + (cs.on ? ' ON' : ' OFF');
        const lbl = this.sim.inputs[c].label;
        u.pin.textContent = lbl === '—' ? 'probe 없음' : '← ' + lbl;
        u.kv.set(U.fmtEng(cs.vdiv, 'V', 3) + '/div');
        u.kp.set((cs.pos >= 0 ? '+' : '') + cs.pos.toFixed(2) + 'div');
        u.kp.knob.title = 'Vertical Position (Offset): ' + U.fmtEng(-cs.pos * cs.vdiv, 'V', 3) + ' 이 화면 중앙';
        u.cpl.set(cs.coupling); u.prb.set(cs.probe);
      }
      this.k.tdiv.set(U.fmtEng(s.tdiv, 's') + '/div');
      this.k.hpos.set(U.fmtEng(s.delay, 's', 3));
      this.k.zoom.set(s.zoom.on ? '×' + s.zoom.factor : 'off');
      this.k.zpos.set(s.zoom.on ? U.fmtEng(s.zoom.center, 's', 3) : '—');
      this.bZoom.classList.toggle('on', s.zoom.on);
      this.bRoll.classList.toggle('on', s.roll);
      this.bRoll.textContent = 'Roll ' + (s.roll ? (sc.isRoll() ? 'ON' : 'Auto') : 'Off');
      this.k.lvl.set(U.fmtEng(s.trig.level, 'V', 4));
      this.k.tpos.set(Math.round(s.trig.pos * 100) + '%');
      this.segs.tmode.set(s.trig.mode); this.segs.tsrc.set(s.trig.source); this.segs.tslope.set(s.trig.slope);
      this.segs.amode.set(s.acq.mode); this.avgSel.value = String(s.acq.avgN); this.avgSel.disabled = s.acq.mode !== 'average';
      this.segs.rl.set(s.acq.srMode === 'auto' ? s.acq.rl : null);
      this.segs.srm.set(s.acq.srMode);
      this.srSel.value = String(s.acq.sr); this.srSel.disabled = s.acq.srMode !== 'manual';
      const H = sc.horiz();
      const lim = H.limited === 'fs' ? '<br><span style="color:#f5c56a">※ 최대 샘플레이트(10 GSa/s) 제한 → 레코드 길이 감소</span>'
        : H.limited === 'rl' ? '<br><span style="color:#f5c56a">※ 최대 레코드 길이(1 Mpts) 제한 → 샘플레이트 감소</span>'
          : H.limited === 'min' ? '<br><span style="color:#f5c56a">※ 최소 10 pts 보장 → 샘플레이트 증가</span>' : '';
      const html = 'Sample Rate <b>' + U.fmtEng(H.fs, 'Sa/s', 4) + '</b> · Record <b>' + U.fmtEng(H.n, 'pts', 4) + '</b><br>' +
        'RL / fs = ' + U.fmtEng(H.n / H.fs, 's', 4) + ' = 10 div × ' + U.fmtEng(s.tdiv, 's') + '/div<br>' +
        '샘플 간격 ' + U.fmtEng(H.dt, 's', 4) + (s.zoom.on ? ' · Zoom 화면 ' + U.fmtEng(H.n / s.zoom.factor, 'pts', 3) : '') + lim;
      if (this._acqHtml !== html) { this.acqInfo.innerHTML = html; this._acqHtml = html; }
      this.segs.vec.set(s.display.vectors); this.segs.noise.set(s.display.noise); this.segs.meas.set(s.display.measure);
    }
  }

  UI.ScopePanel = ScopePanel;
})(window);
