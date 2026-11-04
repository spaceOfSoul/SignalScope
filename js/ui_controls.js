/* ui_controls.js — 창 관리자, 로터리 노브, 세그먼트 버튼, 토스트 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const UI = VS.ui = VS.ui || {};
  const store = VS.util.store;

  UI.el = function (tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    if (children) for (const c of [].concat(children)) if (c !== null && c !== undefined) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  };

  let toastTimer = null;
  UI.toast = function (msg, kind) {
    let t = document.getElementById('toast');
    if (!t) { t = UI.el('div', { id: 'toast', class: 'toast' }); document.body.appendChild(t); }
    t.className = 'toast ' + (kind || '');
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  };

  // ---------------- 창 관리자 ----------------
  class WindowManager {
    constructor(desktop) {
      this.desk = desktop; this.wins = new Map(); this.z = 10;
      this.layoutKey = 'vscope.layout.v1';
      this.customized = false;   // 사용자가 창을 옮기거나 크기를 바꾸기 전에는 기본 배치가 화면 크기를 따라감
      window.addEventListener('resize', () => { clearTimeout(this._rzT); this._rzT = setTimeout(() => { if (this.customized) this.clampAll(); else this.defaultLayout(true); }, 120); });
    }
    add(id, num, title, body, defRect) {
      const w = UI.el('section', { class: 'win', id: id });
      const bMin = UI.el('button', { title: '숨기기', text: '–' });
      const bMax = UI.el('button', { title: '최대화/복원', text: '□' });
      const tb = UI.el('div', { class: 'win-title' }, [UI.el('span', { class: 'num', text: num }), UI.el('span', { class: 'ttl', text: title }), bMax, bMin]);
      const bd = UI.el('div', { class: 'win-body' }, body);
      const rz = UI.el('div', { class: 'win-resize' });
      w.append(tb, bd, rz);
      this.desk.appendChild(w);
      const rec = { id: id, el: w, def: defRect, onResize: [] };
      this.wins.set(id, rec);
      w.addEventListener('pointerdown', () => this.focus(id), true);
      bMin.addEventListener('click', (e) => { e.stopPropagation(); this.hide(id); });
      bMax.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMax(id); });
      tb.addEventListener('dblclick', () => this.toggleMax(id));
      this._drag(tb, w, rec, false);
      this._drag(rz, w, rec, true);
      return rec;
    }
    _drag(handle, w, rec, resize) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target.tagName === 'BUTTON')) return;
        if (w.classList.contains('maximized')) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const r0 = { x: w.offsetLeft, y: w.offsetTop, w: w.offsetWidth, h: w.offsetHeight }, sx = e.clientX, sy = e.clientY;
        const move = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (resize) { w.style.width = Math.max(320, r0.w + dx) + 'px'; w.style.height = Math.max(180, r0.h + dy) + 'px'; this._fire(rec); }
          else { w.style.left = (r0.x + dx) + 'px'; w.style.top = Math.max(0, r0.y + dy) + 'px'; }
        };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); this.customized = true; this.clamp(rec); this.save(); this._fire(rec); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }
    _fire(rec) { for (const f of rec.onResize) f(); }
    onResize(id, fn) { this.wins.get(id).onResize.push(fn); }
    focus(id) {
      for (const [k, r] of this.wins) r.el.classList.toggle('focused', k === id);
      const r = this.wins.get(id); if (r) r.el.style.zIndex = ++this.z;
    }
    show(id) { const r = this.wins.get(id); r.el.classList.remove('hidden'); this.focus(id); this.clamp(r); this._fire(r); this.save(); this._sync(); }
    hide(id) { this.wins.get(id).el.classList.add('hidden'); this.save(); this._sync(); }
    toggle(id) { const r = this.wins.get(id); if (r.el.classList.contains('hidden') || !r.el.classList.contains('focused')) this.show(id); else this.hide(id); }
    toggleMax(id) {
      const r = this.wins.get(id), w = r.el;
      if (w.classList.contains('maximized')) {
        w.classList.remove('maximized'); const p = r.prev; if (p) this._apply(w, p);
      } else {
        r.prev = this._rect(w); w.classList.add('maximized');
        this._apply(w, { x: 0, y: 0, w: this.desk.clientWidth, h: this.desk.clientHeight });
      }
      this.customized = true;
      this.focus(id); this._fire(r); this.save();
    }
    _rect(w) { return { x: w.offsetLeft, y: w.offsetTop, w: w.offsetWidth, h: w.offsetHeight }; }
    _apply(w, r) { w.style.left = r.x + 'px'; w.style.top = r.y + 'px'; w.style.width = r.w + 'px'; w.style.height = r.h + 'px'; }
    clamp(r) {
      const w = r.el, D = this.desk;
      if (w.classList.contains('maximized')) { this._apply(w, { x: 0, y: 0, w: D.clientWidth, h: D.clientHeight }); return; }
      let x = w.offsetLeft, y = w.offsetTop;
      x = Math.min(Math.max(x, -w.offsetWidth + 120), D.clientWidth - 120);
      y = Math.min(Math.max(y, 0), D.clientHeight - 40);
      w.style.left = x + 'px'; w.style.top = y + 'px';
    }
    clampAll() { for (const r of this.wins.values()) { this.clamp(r); this._fire(r); } }
    defaultLayout(keepVisibility) {
      const D = this.desk, W = D.clientWidth, H = D.clientHeight;
      this.customized = false;
      const lw = Math.max(440, Math.min(560, Math.round(W * 0.33)));
      const h1 = Math.max(330, Math.round(H * 0.47));
      for (const r of this.wins.values()) { r.el.classList.remove('maximized'); if (!keepVisibility) r.el.classList.remove('hidden'); }
      const g = 8;
      this._apply(this.wins.get('win1').el, { x: g, y: g, w: lw, h: h1 - g });
      this._apply(this.wins.get('win2').el, { x: g, y: h1 + g, w: lw, h: H - h1 - 2 * g });
      this._apply(this.wins.get('win3').el, { x: lw + 2 * g, y: g, w: Math.max(600, W - lw - 3 * g), h: H - 2 * g });
      for (const r of this.wins.values()) this._fire(r);
      this.focus('win3');
      this.save(); this._sync();
    }
    save() {
      const o = {};
      for (const [k, r] of this.wins) {
        const w = r.el;
        o[k] = { rect: w.classList.contains('maximized') && r.prev ? r.prev : this._rect(w), hidden: w.classList.contains('hidden'), max: w.classList.contains('maximized') };
      }
      o.__vw = this.desk.clientWidth; o.__vh = this.desk.clientHeight; o.__custom = this.customized;
      store.set(this.layoutKey, o);
    }
    restore() {
      const o = store.get(this.layoutKey, null);
      if (!o || !o.win1 || !o.__custom || Math.abs((o.__vw || 0) - this.desk.clientWidth) > 400) {
        this.defaultLayout();
        if (o) for (const [k, r] of this.wins) if (o[k] && o[k].hidden) r.el.classList.add('hidden');
        this._sync();
        return;
      }
      this.customized = true;
      for (const [k, r] of this.wins) {
        const s = o[k]; if (!s) continue;
        this._apply(r.el, s.rect);
        r.el.classList.toggle('hidden', !!s.hidden);
        if (s.max) { r.prev = s.rect; r.el.classList.add('maximized'); }
        this.clamp(r);
      }
      for (const r of this.wins.values()) this._fire(r);
      this.focus('win3');
      this._sync();
    }
    _sync() { if (this.onVisibility) this.onVisibility(); }
    isVisible(id) { return !this.wins.get(id).el.classList.contains('hidden'); }
  }
  UI.WindowManager = WindowManager;

  // ---------------- 로터리 노브 ----------------
  /**
   * opts: { label, color, onStep(dir, fine), onReset(), title }
   * 마우스 휠/세로 드래그/◀▶ 버튼으로 단계 조절, 더블클릭 = 기본값(onReset)
   */
  class Knob {
    constructor(opts) {
      this.o = opts; this.ang = 0;
      this.knob = UI.el('div', { class: 'knob', title: (opts.title || opts.label) + '\n휠/드래그: 조절 · Shift: 미세 · 더블클릭: 기본값' });
      if (opts.color) this.knob.style.setProperty('--kc', opts.color);
      this.val = UI.el('div', { class: 'kval' });
      const bL = UI.el('button', { text: '◀', title: '감소' }), bR = UI.el('button', { text: '▶', title: '증가' });
      this.el = UI.el('div', { class: 'knob-wrap' }, [UI.el('div', { class: 'klbl', text: opts.label }), this.knob, this.val, UI.el('div', { class: 'karrows' }, [bL, bR])]);
      bL.addEventListener('click', (e) => this.step(-1, e.shiftKey));
      bR.addEventListener('click', (e) => this.step(1, e.shiftKey));
      this.knob.addEventListener('wheel', (e) => { e.preventDefault(); this.step(e.deltaY < 0 ? 1 : -1, e.shiftKey); }, { passive: false });
      this.knob.addEventListener('dblclick', () => { if (opts.onReset) opts.onReset(); });
      this.knob.addEventListener('pointerdown', (e) => {
        e.preventDefault(); this.knob.setPointerCapture(e.pointerId);
        let acc = 0, ly = e.clientY;
        const mv = (ev) => {
          acc += ly - ev.clientY; ly = ev.clientY;
          while (acc >= 9) { acc -= 9; this.step(1, ev.shiftKey); }
          while (acc <= -9) { acc += 9; this.step(-1, ev.shiftKey); }
        };
        const up = () => { this.knob.removeEventListener('pointermove', mv); this.knob.removeEventListener('pointerup', up); };
        this.knob.addEventListener('pointermove', mv); this.knob.addEventListener('pointerup', up);
      });
    }
    step(dir, fine) {
      this.ang += dir * 18; this.knob.style.setProperty('--ang', this.ang + 'deg');
      if (this.o.onStep) this.o.onStep(dir, fine);
    }
    set(text) { if (this.val.textContent !== text) this.val.textContent = text; }
  }
  UI.Knob = Knob;

  /** 세그먼트 버튼: options [{v,label,title}] */
  UI.seg = function (options, value, onChange) {
    const wrap = UI.el('div', { class: 'seg' });
    const btns = options.map(o => {
      const b = UI.el('button', { text: o.label, title: o.title || '' });
      b.addEventListener('click', () => { onChange(o.v); });
      wrap.appendChild(b);
      return { b: b, v: o.v };
    });
    const api = {
      el: wrap,
      set(v) { for (const x of btns) x.b.classList.toggle('on', x.v === v); },
      enable(on) { for (const x of btns) x.b.disabled = !on; }
    };
    api.set(value);
    return api;
  };

  UI.select = function (options, value, onChange, attrs) {
    const s = UI.el('select', attrs || {});
    for (const o of options) s.appendChild(UI.el('option', { value: String(o.v), text: o.label }));
    s.value = String(value);
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };

  /** 텍스트 파일 다운로드 */
  UI.download = function (name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = UI.el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  /** 파일 선택 → 텍스트 읽기 */
  UI.pickFile = function (accept, multiple) {
    return new Promise((resolve) => {
      const inp = UI.el('input', { type: 'file', accept: accept || '', style: 'display:none' });
      if (multiple) inp.multiple = true;
      inp.addEventListener('change', async () => {
        const out = [];
        for (const f of inp.files) out.push({ name: f.name, text: await f.text() });
        inp.remove(); resolve(out);
      });
      document.body.appendChild(inp); inp.click();
    });
  };
})(window);
