/* ui_pins.js — 창 1: 출력 핀 설정 및 Probe 배치 */
(function (G) {
  'use strict';
  const VS = G.VS, UI = VS.ui, U = VS.util;
  const SVGNS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const KIND_LABEL = { gpio: 'GPIO 출력', pwm: 'GPIO + PWM', dac: 'DAC (아날로그)' };
  const FILTER_OPTS = [{ v: 'none', label: '사용안함' }, { v: 'LPF', label: 'LPF (R-C)' }, { v: 'HPF', label: 'HPF (C-R)' }];

  class PinsWindow {
    constructor(sim, onChange) {
      this.sim = sim; this.onChange = onChange || (() => {});
      this.cfg = sim.board.pins.map(() => ({ filter: { type: 'none', R: 1000, C: 100e-9 }, enabled: true }));
      this.rows = [];
      this.el = UI.el('div', { class: 'win-body', style: 'flex:1;min-height:0' });
      this._build();
    }
    _build() {
      const sim = this.sim;
      const tb = UI.el('div', { class: 'toolbar' }, [
        UI.el('span', { class: 'hint', html: '측정할 핀을 <b>클릭/체크</b>하세요 (최대 2개 → CH1, CH2)' }),
        UI.el('span', { style: 'flex:1' }),
        UI.el('button', { text: '⇄ CH1/CH2 교환', title: 'CH1 과 CH2 에 연결된 핀을 서로 바꿉니다', onclick: () => this.swap() }),
        UI.el('button', { text: '프로브 해제', onclick: () => { this.setProbe(0, null); this.setProbe(1, null); } })
      ]);
      this.svg = svg('svg', { class: 'board-svg', viewBox: '0 0 560 168' });
      const wrap = UI.el('div', { class: 'board-wrap' }, [this.svg]);
      const table = UI.el('table', { class: 'pins' });
      table.appendChild(UI.el('thead', null, UI.el('tr', null, ['Probe', '출력 Pin', '현재 출력', 'Filter', '사용'].map(t => UI.el('th', { text: t })))));
      const tbody = UI.el('tbody'); table.appendChild(tbody);
      for (const p of sim.board.pins) {
        const i = p.id - 1, c = this.cfg[i];
        const chk = UI.el('input', { type: 'checkbox', title: '프로브 연결' });
        const badge = UI.el('span', { class: 'chbadge none', text: '—' });
        const probeCell = UI.el('label', { class: 'probe-cell' }, [chk, badge]);
        chk.addEventListener('change', () => this.toggleProbe(p.id, chk));
        const led = UI.el('span', { class: 'led' });
        const nameCell = UI.el('td', null, [UI.el('div', null, [led, UI.el('span', { class: 'pinname', text: p.name })]), UI.el('div', { class: 'pintype', text: KIND_LABEL[p.kind] })]);
        const out = UI.el('td', { class: 'out', text: '' });
        const fsel = UI.select(FILTER_OPTS, c.filter.type, (v) => { c.filter.type = v; this.applyFilter(p.id); });
        const rIn = UI.el('input', { type: 'text', value: '1k', title: '저항 R (Ω) 예: 1k, 4.7k, 100' });
        const cIn = UI.el('input', { type: 'text', value: '100n', title: '커패시터 C (F) 예: 100n, 1u, 10n' });
        const fc = UI.el('span', { class: 'fc' });
        const rc = UI.el('div', { class: 'rc' }, ['R', rIn, 'C', cIn, fc]);
        const onRC = () => {
          const R = U.parseEng(rIn.value), C = U.parseEng(cIn.value);
          if (!(R > 0) || !(C > 0)) { UI.toast('R, C 값을 확인하세요 (예: 1k, 100n)', 'warn'); return; }
          c.filter.R = R; c.filter.C = C; this.applyFilter(p.id);
        };
        rIn.addEventListener('change', onRC); cIn.addEventListener('change', onRC);
        const esel = UI.select([{ v: 'en', label: 'Enable' }, { v: 'dis', label: 'Disable' }], 'en', (v) => {
          c.enabled = v === 'en'; sim.setEnabled(p.id, c.enabled); this.refresh(); this.onChange();
        });
        const tr = UI.el('tr', null, [UI.el('td', null, probeCell), nameCell, out, UI.el('td', null, [fsel, rc]), UI.el('td', null, esel)]);
        tbody.appendChild(tr);
        this.rows.push({ p: p, chk: chk, badge: badge, led: led, out: out, fsel: fsel, rIn: rIn, cIn: cIn, fc: fc, rc: rc, esel: esel, tr: tr });
      }
      this.el.append(tb, wrap, UI.el('div', { class: 'pin-table-wrap' }, table));
      this._buildSvg();
      this.refresh();
    }

    _buildSvg() {
      const s = this.svg; s.innerHTML = '';
      const defs = svg('defs', {}, s);
      const lg = svg('linearGradient', { id: 'chipg', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      svg('stop', { offset: '0', 'stop-color': '#2f3540' }, lg); svg('stop', { offset: '1', 'stop-color': '#1d2128' }, lg);
      // PCB
      svg('rect', { x: 2, y: 2, width: 556, height: 164, rx: 9, fill: '#123524', stroke: '#1f5a3c' }, s);
      svg('rect', { x: 12, y: 10, width: 158, height: 148, rx: 6, fill: 'url(#chipg)', stroke: '#4a5361' }, s);
      const tt = svg('text', { x: 52, y: 66, 'text-anchor': 'middle', fill: '#cfd6e0', 'font-size': 13, 'font-weight': 700 }, s); tt.textContent = 'MCU';
      const t2 = svg('text', { x: 52, y: 82, 'text-anchor': 'middle', fill: '#8d97a6', 'font-size': 10 }, s); t2.textContent = 'Lua 5.3';
      this.svgClk = svg('text', { x: 52, y: 100, 'text-anchor': 'middle', fill: '#8d97a6', 'font-size': 9.5 }, s);
      this.svgVoh = svg('text', { x: 52, y: 113, 'text-anchor': 'middle', fill: '#8d97a6', 'font-size': 9.5 }, s);
      const gt = svg('text', { x: 548, y: 161, 'text-anchor': 'end', fill: '#5f8f74', 'font-size': 9 }, s); gt.textContent = 'GND ⏚ 공통';
      this.svgPins = [];
      for (const p of this.sim.board.pins) {
        const i = p.id - 1, y = 24 + i * 24;
        const g = svg('g', { class: 'pin-hit' }, s);
        svg('rect', { x: 100, y: y - 11, width: 456, height: 22, fill: 'transparent' }, g);
        const lbl = svg('text', { x: 162, y: y + 4, 'text-anchor': 'end', fill: '#dfe5ec', 'font-size': 11, 'font-family': 'Consolas, monospace' }, g); lbl.textContent = p.name;
        const pad = svg('rect', { class: 'pinpad', x: 170, y: y - 4, width: 10, height: 8, fill: '#c9a227', stroke: '#6b5a1c' }, g);
        const led = svg('circle', { cx: 110, cy: y, r: 4, fill: '#2a2f37', stroke: '#111' }, g);
        const line = svg('path', { d: '', stroke: '#c9a227', 'stroke-width': 2, fill: 'none' }, g);
        const comp = svg('g', {}, g);
        const ftxt = svg('text', { x: 307, y: y - 7, 'text-anchor': 'middle', fill: '#9fd3b4', 'font-size': 8.5 }, g);
        const probe = svg('g', {}, g);
        g.addEventListener('click', () => {
          const r = this.rows[i];
          r.chk.checked = !r.chk.checked;
          this.toggleProbe(p.id, r.chk);
        });
        this.svgPins.push({ y: y, line: line, comp: comp, ftxt: ftxt, probe: probe, led: led, pad: pad });
      }
    }

    _drawPinSvg(i) {
      const r = this.rows[i], sp = this.svgPins[i], c = this.cfg[i], y = sp.y;
      const en = c.enabled, f = c.filter.type;
      const col = en ? '#c9a227' : '#5d6470';
      sp.line.setAttribute('stroke', col);
      sp.line.setAttribute('stroke-dasharray', en ? '' : '4 3');
      sp.comp.innerHTML = '';
      if (f === 'none') {
        sp.line.setAttribute('d', `M180 ${y} H470`);
        sp.ftxt.textContent = '';
      } else {
        // 필터 단: LPF = 직렬 R + 접지 C,  HPF = 직렬 C + 접지 R
        sp.line.setAttribute('d', `M180 ${y} H262 M352 ${y} H470`);
        const st = { stroke: '#9fd3b4', 'stroke-width': 1.5, fill: 'none' };
        if (f === 'LPF') {          // 직렬 R
          svg('path', Object.assign({ d: `M262 ${y} H276 M324 ${y} H338` }, st), sp.comp);
          svg('rect', Object.assign({ x: 276, y: y - 5, width: 48, height: 10 }, st), sp.comp);
        } else {                    // 직렬 C
          svg('path', Object.assign({ d: `M262 ${y} H296 M296 ${y - 8} V${y + 8} M304 ${y - 8} V${y + 8} M304 ${y} H338` }, st), sp.comp);
        }
        const gx = 352;
        svg('path', Object.assign({ d: `M338 ${y} H${gx}` }, st), sp.comp);
        if (f === 'LPF')            // 접지 C
          svg('path', Object.assign({ d: `M${gx} ${y} V${y + 4} M${gx - 6} ${y + 4} H${gx + 6} M${gx - 6} ${y + 7} H${gx + 6} M${gx} ${y + 7} V${y + 10} M${gx - 4} ${y + 10} H${gx + 4}` }, st), sp.comp);
        else {                      // 접지 R
          svg('rect', Object.assign({ x: gx - 2.5, y: y + 1, width: 5, height: 8 }, st), sp.comp);
          svg('path', Object.assign({ d: `M${gx} ${y} V${y + 1} M${gx} ${y + 9} V${y + 10} M${gx - 4} ${y + 10} H${gx + 4}` }, st), sp.comp);
        }
        svg('circle', { cx: gx, cy: y, r: 1.8, fill: '#9fd3b4' }, sp.comp);
        sp.ftxt.textContent = f + ' fc=' + U.fmtEng(1 / (2 * Math.PI * c.filter.R * c.filter.C), 'Hz', 3);
      }
      // 프로브
      sp.probe.innerHTML = '';
      const ch = this.sim.probes.indexOf(r.p.id);
      if (ch >= 0) {
        const pc = ch === 0 ? '#ffd400' : '#1fd6e8';
        svg('circle', { cx: 470, cy: y, r: 3, fill: pc }, sp.probe);
        svg('path', { d: `M470 ${y} L486 ${y - 8} H506`, stroke: pc, 'stroke-width': 2, fill: 'none' }, sp.probe);
        svg('rect', { x: 506, y: y - 13, width: 38, height: 11, rx: 3, fill: pc }, sp.probe);
        const t = svg('text', { x: 525, y: y - 4.5, 'text-anchor': 'middle', fill: '#111', 'font-size': 9, 'font-weight': 700 }, sp.probe); t.textContent = 'CH' + (ch + 1);
      } else {
        svg('circle', { cx: 470, cy: y, r: 2.5, fill: 'none', stroke: '#6b7480' }, sp.probe);
      }
    }

    toggleProbe(pinId, chk) {
      const pr = this.sim.probes;
      const cur = pr.indexOf(pinId);
      if (chk.checked) {
        if (cur >= 0) return;
        const free = pr.indexOf(null);
        if (free < 0) { chk.checked = false; UI.toast('Probe 는 최대 2개(CH1, CH2)까지 지정할 수 있습니다.', 'warn'); return; }
        this.setProbe(free, pinId);
      } else if (cur >= 0) this.setProbe(cur, null);
    }
    setProbe(ch, pinId) {
      this.sim.setProbe(ch, pinId);
      this.refresh();
      this.onChange();
    }
    swap() {
      const [a, b] = this.sim.probes;
      this.sim.setProbe(0, b); this.sim.setProbe(1, a);
      this.refresh(); this.onChange();
    }
    applyFilter(pinId) {
      const c = this.cfg[pinId - 1];
      this.sim.setFilter(pinId, c.filter);
      this.refresh(); this.onChange();
    }
    /** 저장된 설정 적용 (시작 시) */
    load(state) {
      if (!state) return;
      if (state.cfg) state.cfg.forEach((c, i) => {
        if (!this.cfg[i] || !c) return;
        this.cfg[i] = { filter: { type: c.filter.type, R: c.filter.R, C: c.filter.C }, enabled: c.enabled !== false };
        const r = this.rows[i];
        r.fsel.value = c.filter.type; r.rIn.value = U.fmtEng(c.filter.R, ''); r.cIn.value = U.fmtEng(c.filter.C, '').replace('µ', 'u');
        r.esel.value = c.enabled !== false ? 'en' : 'dis';
        this.sim.setFilter(i + 1, this.cfg[i].filter);
        if (c.enabled === false) this.sim.setEnabled(i + 1, false);
      });
      if (state.probes) state.probes.forEach((pid, ch) => this.sim.setProbe(ch, pid || null));
      this.refresh();
    }
    save() { return { cfg: this.cfg, probes: this.sim.probes.slice() }; }

    refresh() {
      const pr = this.sim.probes;
      this.svgClk.textContent = 'CLK ' + U.fmtEng(this.sim.board.clk, 'Hz');
      this.svgVoh.textContent = 'VOH ' + this.sim.board.voh + ' V';
      this.rows.forEach((r, i) => {
        const ch = pr.indexOf(r.p.id), c = this.cfg[i];
        r.chk.checked = ch >= 0;
        r.badge.className = 'chbadge ' + (ch === 0 ? 'c1' : ch === 1 ? 'c2' : 'none');
        r.badge.textContent = ch >= 0 ? 'CH' + (ch + 1) : '—';
        r.tr.classList.toggle('probed', ch >= 0);
        r.tr.classList.toggle('disabled', !c.enabled);
        r.rc.style.display = c.filter.type === 'none' ? 'none' : 'flex';
        r.fc.textContent = c.filter.type === 'none' ? '' : 'τ=' + U.fmtEng(c.filter.R * c.filter.C, 's') + ' fc=' + U.fmtEng(1 / (2 * Math.PI * c.filter.R * c.filter.C), 'Hz');
        this._drawPinSvg(i);
      });
      this.live();
    }
    /** 실시간 출력 상태 갱신 (주기적으로 호출) */
    live() {
      const t = this.sim.simTime;
      this.rows.forEach((r, i) => {
        const p = r.p, txt = p.describe();
        if (r.out.textContent !== txt) r.out.textContent = txt;
        let col = '#2a2f37';
        if (p.enabled) {
          if (p.kind === 'dac') { const k = p.dacVoltage / p.board.vref; col = `rgba(80,160,255,${0.15 + 0.85 * k})`; }
          else if (p.kind === 'pwm' && p.pwmOn) { const k = p.pwmDuty / 100; col = `rgba(255,170,40,${0.2 + 0.8 * k})`; }
          else col = p.level ? '#3cff7a' : '#1d3a26';
        }
        r.led.style.background = col;
        this.svgPins[i].led.setAttribute('fill', col);
      });
    }
  }

  UI.PinsWindow = PinsWindow;
})(window);
