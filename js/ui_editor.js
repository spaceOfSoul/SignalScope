/* ui_editor.js — 경량 Lua 코드 편집기 (구문 강조, 줄 번호, 자동 들여쓰기, 오류 줄 표시) */
(function (G) {
  'use strict';
  const VS = G.VS, UI = VS.ui;

  const KW = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
  const API = new Set(('gpio_write gpio_read gpio_toggle digitalWrite digitalRead pwm pwm_start pwm_set_freq pwm_set_duty pwm_stop pwm_read ' +
    'dac_write dac_write_voltage dac_write_v dac_read analogWrite pin_read pin_voltage pin_enabled delay delay_ms delay_us delay_ns sleep ' +
    'delay_clk wait_clk wait_until wait_until_clk every millis micros nanos sim_time clk ticks clk_freq cpi print printf ' +
    'http_request http_get http_post ws_open ws_send ws_recv ws_poll ws_available ws_state ws_close ' +
    'io fs os string table math coroutine require dofile loadfile pcall error assert tostring tonumber ipairs pairs select type load').split(' '));
  const CONST = new Set('GPIO1 GPIO2 PWM1 PWM2 DAC1 DAC2 HIGH LOW VCC VREF DAC_MAX'.split(' '));
  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const RE = /--\[(=*)\[[\s\S]*?(?:\]\1\]|$)|--[^\n]*|\[(=*)\[[\s\S]*?(?:\]\2\]|$)|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[=~<>]=|<<|>>|\/\/|\.\.\.?|[+\-*\/%^#&~|<>=]|[\s\S]/g;

  function highlight(src) {
    let out = '';
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(src)) !== null) {
      const t = m[0];
      const c = t.charCodeAt(0);
      if (t.startsWith('--')) out += '<span class="tok-com">' + esc(t) + '</span>';
      else if (c === 34 || c === 39 || (t[0] === '[' && (t[1] === '[' || t[1] === '='))) out += '<span class="tok-str">' + esc(t) + '</span>';
      else if (c >= 48 && c <= 57 || (c === 46 && t.length > 1 && t[1] !== '.')) out += '<span class="tok-num">' + t + '</span>';
      else if (/^[A-Za-z_]/.test(t)) {
        if (KW.has(t)) out += '<span class="tok-kw">' + t + '</span>';
        else if (CONST.has(t)) out += '<span class="tok-const">' + t + '</span>';
        else if (API.has(t)) out += '<span class="tok-api">' + t + '</span>';
        else out += t;
      } else if (/^[=~<>+\-*\/%^#&|]/.test(t) && t.length <= 3 && !/\s/.test(t)) out += '<span class="tok-op">' + esc(t) + '</span>';
      else out += esc(t);
    }
    return out;
  }

  class CodeEditor {
    constructor(opts) {
      this.o = opts || {};
      this.gutter = UI.el('div', { class: 'gutter' });
      this.pre = UI.el('pre');
      this.ta = UI.el('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
      this.errBg = UI.el('div', { class: 'err-line-bg', style: 'display:none' });
      this.area = UI.el('div', { class: 'area' }, [this.errBg, this.pre, this.ta]);
      this.el = UI.el('div', { class: 'editor' }, [this.gutter, this.area]);
      this.errLine = null; this.nLines = 0; this._raf = 0;
      this.ta.addEventListener('input', () => { this.clearError(); this._schedule(); if (this.o.onChange) this.o.onChange(); });
      this.ta.addEventListener('scroll', () => this._syncScroll());
      this.ta.addEventListener('keydown', (e) => this._key(e));
    }
    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.clearError(); this._render(); this.ta.scrollTop = 0; this._syncScroll(); }
    _schedule() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); }); }
    _render() {
      const v = this.ta.value;
      this.pre.innerHTML = highlight(v) + '\n';
      const n = v.split('\n').length;
      if (n !== this.nLines || this._gutterDirty) {
        this.nLines = n; this._gutterDirty = false;
        let h = '';
        for (let i = 1; i <= n; i++) h += '<div' + (i === this.errLine ? ' class="errl"' : '') + '>' + i + '</div>';
        this.gutter.innerHTML = h + '<div>&nbsp;</div>';
      }
      this._syncScroll();
    }
    _syncScroll() {
      this.pre.scrollTop = this.ta.scrollTop; this.pre.scrollLeft = this.ta.scrollLeft;
      this.gutter.scrollTop = this.ta.scrollTop;
      if (this.errLine) { this.errBg.style.top = (6 + (this.errLine - 1) * 19 - this.ta.scrollTop) + 'px'; }
    }
    setError(line) {
      this.errLine = line; this._gutterDirty = true;
      this.errBg.style.display = line ? 'block' : 'none';
      this._render();
      if (line) {
        const top = (line - 1) * 19;
        if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - 30) this.ta.scrollTop = Math.max(0, top - 60);
        this._syncScroll();
      }
    }
    clearError() { if (this.errLine) { this.errLine = null; this._gutterDirty = true; this.errBg.style.display = 'none'; this._schedule(); } }
    _insert(text) {
      // execCommand 는 실행취소(undo) 이력을 유지한다
      if (!document.execCommand('insertText', false, text)) {
        const ta = this.ta, s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
        ta.selectionStart = ta.selectionEnd = s + text.length;
        this._schedule();
      }
    }
    _key(e) {
      const ta = this.ta;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (this.o.onRun) this.o.onRun(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (this.o.onSave) this.o.onSave(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
        if (s !== en && v.slice(s, en).indexOf('\n') >= 0) {
          const ls = v.lastIndexOf('\n', s - 1) + 1;
          const block = v.slice(ls, en);
          const nb = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
          ta.selectionStart = ls; ta.selectionEnd = en;
          this._insert(nb);
          ta.selectionStart = ls; ta.selectionEnd = ls + nb.length;
        } else if (!e.shiftKey) this._insert('  ');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const s = ta.selectionStart, v = ta.value;
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const line = v.slice(ls, s);
        let ind = (/^\s*/.exec(line) || [''])[0];
        if (/\b(do|then|else|repeat|function\b.*\))\s*$/.test(line) || /\bfunction\s*\([^)]*\)\s*$/.test(line) || /\{\s*$/.test(line)) ind += '  ';
        e.preventDefault();
        this._insert('\n' + ind);
      }
    }
    focus() { this.ta.focus(); }
  }

  UI.CodeEditor = CodeEditor;
  UI.highlightLua = highlight;
})(window);
