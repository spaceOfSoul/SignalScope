/* ui_script.js — 창 2: 출력 제어 (Lua 스크립트 편집/실행, 시뮬레이션 제어, 콘솔, 파일, API 도움말) */
(function (G) {
  'use strict';
  const VS = G.VS, UI = VS.ui, U = VS.util;

  const CLK_LIST = [1e6, 2e6, 4e6, 8e6, 10e6, 16e6, 20e6, 48e6, 50e6, 100e6];
  const CPI_LIST = [0, 1, 2, 4, 8, 10, 16, 32, 64];

  const API_DOC = [
    ['핀 / 상수', [
      ['GPIO1, GPIO2, PWM1, PWM2, DAC1, DAC2', '핀 번호 상수 (1~6). 문자열 "GPIO1" 도 가능'],
      ['HIGH, LOW, VCC, VREF, DAC_MAX', '1, 0, 3.3 V, 3.3 V, 4095 (12bit DAC)']]],
    ['GPIO', [
      ['gpio_write(pin, v)  · digitalWrite', 'High/Low 출력 (v: HIGH/LOW, 1/0, true/false). PWM 핀에 쓰면 PWM 정지 후 GPIO 출력'],
      ['gpio_toggle(pin)', '출력 반전'],
      ['gpio_read(pin)  · digitalRead', '출력 레지스터(=실제 출력) 읽기. PWM 동작 중이면 현재 순간 레벨']]],
    ['PWM (PWM1, PWM2)', [
      ['pwm_start(pin, freq_hz, duty_pct)  · pwm', 'PWM 시작. 주기/High 시간은 보드 클럭 tick 으로 양자화'],
      ['pwm_set_freq(pin, hz) / pwm_set_duty(pin, pct)', '동작 중 변경 (카운터 연속: 위상 유지)'],
      ['pwm_stop(pin [, level])', 'PWM 정지 후 level(기본 LOW) 출력'],
      ['f, duty, running = pwm_read(pin)', '실제 적용된 주파수/듀티(양자화 결과)'],
      ['analogWrite(PWMx, 0..255)', 'Arduino 방식 듀티 설정']]],
    ['DAC (DAC1, DAC2)', [
      ['dac_write(pin, code)', '12bit 코드 0..4095'],
      ['dac_write_voltage(pin, volt)  · dac_write_v', '전압으로 출력 (0..VREF)'],
      ['code, volt = dac_read(pin)', '출력 레지스터 읽기'],
      ['analogWrite(DACx, code)', 'dac_write 와 동일']]],
    ['공통 읽기', [
      ['pin_read(pin)', '레지스터 테이블 {name,type,enabled,voltage,level,freq,duty,code,...}'],
      ['pin_voltage(pin) / pin_enabled(pin)', '현재 출력 전압 / Enable 여부']]],
    ['시간 · 클럭 (Simulation Clock)', [
      ['delay(ms) · delay_us(us) · delay_ns(ns) · sleep(s)', '지연 (보드 클럭 엣지로 올림 정렬)'],
      ['delay_clk(n) · wait_clk(n)', 'n 클럭 사이클 대기'],
      ['wait_until(t_s) · wait_until_clk(tick)', '절대 시각까지 대기 (드리프트 없는 주기 제어)'],
      ['for n, t in every(period_s [, count]) do … end', '드리프트 없는 주기 루프'],
      ['sim_time() · millis() · micros() · nanos()', '현재 시뮬레이션 시각'],
      ['ticks() · clk()  /  clk_freq()', '보드 클럭 tick 카운트 / 클럭 주파수(Hz)'],
      ['cpi([n])', '명령어당 클럭 수 조회/변경 (0 = 이상적 0-시간 실행)']]],
    ['파일 (가상 파일 시스템, [파일] 탭)', [
      ['io.open(name, mode) → file', 'mode: r, w, a, r+, w+, a+.  file:read("l"|"L"|"n"|"a"|n), file:write(...), file:lines(), file:seek(), file:close()'],
      ['io.lines(name) · io.write(...)', '줄 단위 읽기 / 콘솔 출력'],
      ['fs.list() · fs.exists(n) · fs.read(n) · fs.write(n,s) · fs.append(n,s) · fs.remove(n)', '파일 유틸리티'],
      ['dofile(n) · loadfile(n) · require("mod")', '다른 스크립트 파일 로드 (mod.lua)'],
      ['os.remove · os.rename · os.clock()', 'os.clock = 스크립트 시작 후 경과 시뮬레이션 시간']]],
    ['네트워크: HTTP (시뮬레이션 시계는 대기 중에도 계속 흐름)', [
      ['req = http_request(url [, opts])', '요청만 걸고 즉시 반환 (비동기). opts: method, body, headers{}, content_type, net_timeout(실제 초, 기본 15)'],
      ['req:ready() · req:result()', '도착 여부 / body, status, headers (실패: nil, 오류, 미완료: nil, "pending"). 대기 중 출력은 스크립트가 결정'],
      ['req:wait([timeout]) · req:cancel()', '도착할 때까지 잠들어 대기 (delay 와 같음, 출력 유지). timeout = 시뮬레이션 시간(초) → nil, "timeout"'],
      ['body, status, headers = http_get(url [, opts])', '요청 + 대기. opts.timeout = 시뮬레이션 시간(초)'],
      ['http_post(url, body [, opts])', 'POST 요청 + 대기. 기본 Content-Type: text/plain'],
      ['body 는 바이트 그대로', '텍스트/바이너리 모두 손실 없음 (string.unpack 으로 바이너리 해석 가능)']]],
    ['네트워크: WebSocket', [
      ['ws, err = ws_open(url [, {timeout, protocols, wait}])', '연결될 때까지 대기 후 반환 (wait=false: 즉시 반환, 연결 전 send 는 연결 후 전송)'],
      ['ws:send(data [, "text"|"binary"])', '전송 (기본: UTF-8 이면 text 프레임, 아니면 binary 프레임)'],
      ['ws:poll() · ws:available()', '대기 없이 메시지 1개 꺼내기 (없으면 nil) / 쌓인 메시지 수'],
      ['msg, err = ws:recv([timeout])', '메시지가 올 때까지 잠들어 대기. err: "timeout" | "closed"'],
      ['ws:state() · ws:error() · ws:dropped() · ws:close()', '"connecting|open|closing|closed" / 오류 / 대기열 초과로 버린 수 / 닫기'],
      ['ws_send(ws, …) · ws_recv · ws_poll · ws_available · ws_state · ws_close', '함수형 별칭'],
      ['서버 예제: tools/signal_server.py', 'HTTP /api/info, /api/frame/<k> · WebSocket /ws, /relay (UDP/TCP 중계). 스크립트 정지 시 요청 취소·소켓 닫힘']]],
    ['언어 (Lua 5.3, fengari)', [
      ['local x = 10; x = x + 1', '변수 선언 / 대입. 정수는 32bit (MCU 레지스터와 동일 폭)'],
      ['+ - * / // % ^   & | ~ << >> ~x', '산술 / 비트 연산'],
      ['if … then … elseif … else … end', '조건문'],
      ['while / repeat-until / for i=a,b,s / for k,v in pairs(t)', '반복문'],
      ['print(...) · printf(fmt, ...)', '콘솔 출력 (시뮬레이션 시각 표시)']]]
  ];

  class ScriptWindow {
    constructor(sim, app) {
      this.sim = sim; this.app = app;
      this.name = 'script.lua';
      this.el = UI.el('div', { class: 'win-body', style: 'flex:1;min-height:0' });
      this.conLines = []; this.conPending = []; this.conRaw = '';
      this._build();
      sim.on('console', (m) => this._log(m));
      sim.on('state', () => this.updateState());
      sim.vfs.onChange(() => { clearTimeout(this._fT); this._fT = setTimeout(() => this.renderFiles(), 250); });
    }
    _build() {
      const sim = this.sim;
      // 툴바 1: 파일
      this.nameIn = UI.el('input', { type: 'text', value: this.name, style: 'width:130px', title: '스크립트 이름 (VFS 저장/오류 메시지에 사용)' });
      this.nameIn.addEventListener('change', () => { this.name = this.nameIn.value.trim() || 'script.lua'; this.nameIn.value = this.name; this.app.saveSoon(); });
      const exSel = UI.el('select', { title: '예제 불러오기 (권장 프로브/스코프 설정도 함께 적용)', style: 'max-width:150px' });
      exSel.appendChild(UI.el('option', { value: '', text: '예제 불러오기…' }));
      VS.EXAMPLES.forEach((ex, i) => exSel.appendChild(UI.el('option', { value: String(i), text: ex.title })));
      exSel.addEventListener('change', () => { if (exSel.value !== '') this.loadExample(+exSel.value); exSel.value = ''; });
      const tb1 = UI.el('div', { class: 'toolbar' }, [
        UI.el('button', { text: '📂 열기', title: 'PC 에서 .lua 파일 불러오기', onclick: () => this.openFromPC() }),
        UI.el('button', { text: '💾 저장', title: 'PC 로 저장 (Ctrl+S)', onclick: () => this.saveToPC() }),
        UI.el('button', { text: '⇪ VFS', title: '현재 스크립트를 가상 파일 시스템에 저장 (dofile/require 로 사용 가능)', onclick: () => this.saveToVFS() }),
        this.nameIn, UI.el('span', { class: 'sep' }), exSel
      ]);
      // 툴바 2: 실행 제어
      this.bRun = UI.el('button', { text: '▶ 실행', title: '스크립트 실행 (Ctrl+Enter)', onclick: () => this.run() });
      this.bPause = UI.el('button', { text: '⏸ 일시정지', title: '시뮬레이션 일시정지/재개 — 보드와 계측기의 가상 시간 정지', onclick: () => this.app.togglePause() });
      this.bStop = UI.el('button', { text: '■ 정지', title: '스크립트 실행 중단 (출력은 마지막 상태 유지)', onclick: () => sim.stopScript() });
      this.speedSeg = UI.seg([{ v: 0.1, label: '0.1X' }, { v: 1, label: '1X' }, { v: 10, label: '10X' }, { v: 'max', label: 'MAX' }], sim.speed, (v) => this.app.setSpeed(v));
      this.statePill = UI.el('span', { class: 'statepill', text: 'IDLE' });
      this.timeLbl = UI.el('span', { class: 'mono dim', style: 'min-width:120px' });
      const tb2 = UI.el('div', { class: 'toolbar' }, [this.bRun, this.bPause, this.bStop, UI.el('span', { class: 'sep' }),
        UI.el('label', null, ['속도', this.speedSeg.el]), this.statePill, this.timeLbl]);
      // 툴바 3: 보드 설정
      this.clkSel = UI.select(CLK_LIST.map(v => ({ v: v, label: U.fmtEng(v, 'Hz') })), sim.board.clk, (v) => {
        if (sim.runtime.running) { UI.toast('스크립트 실행 중에는 클럭을 변경할 수 없습니다', 'warn'); this.clkSel.value = String(sim.board.clk); return; }
        sim.setClock(+v); this.app.saveSoon(); setTimeout(() => this.app.pins.refresh(), 50);
      }, { title: '보드 시스템 클럭: PWM 분해능, 명령어 시간, 출력 갱신 시점의 기준' });
      this.cpiSel = UI.select(CPI_LIST.map(v => ({ v: v, label: v === 0 ? '0 (이상적)' : String(v) })), sim.runtime.cpi, (v) => { sim.setCPI(+v); this.app.saveSoon(); },
        { title: 'Lua 명령어 1개당 소요 클럭 수 (0 = 명령어 실행 시간 0)' });
      this.resetChk = UI.el('input', { type: 'checkbox' }); this.resetChk.checked = sim.resetOutputsOnRun;
      this.resetChk.addEventListener('change', () => { sim.resetOutputsOnRun = this.resetChk.checked; this.app.saveSoon(); });
      const tb3 = UI.el('div', { class: 'toolbar' }, [
        UI.el('label', null, ['CLK', this.clkSel]), UI.el('label', null, ['CPI', this.cpiSel]),
        UI.el('label', { title: '실행 시 모든 출력 레지스터를 0 으로 초기화' }, [this.resetChk, '실행 시 출력 초기화']),
        UI.el('span', { style: 'flex:1' }),
        UI.el('button', { text: '⟲ 시뮬레이션 리셋', title: '시뮬레이션 시간을 0 으로 되돌리고 보드/계측기 상태 초기화', onclick: () => { if (confirm('시뮬레이션을 리셋할까요? (시간 0, 스크립트 정지, 출력 초기화)')) sim.resetSimulation(); } })
      ]);
      // 편집기
      this.editor = new UI.CodeEditor({ onRun: () => this.run(), onSave: () => this.saveToPC(), onChange: () => this.app.saveSoon() });
      // 하단 패널
      this.tabs = {};
      const tabBar = UI.el('div', { class: 'tabs' });
      const pages = UI.el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
      const mkTab = (key, label, page) => {
        const b = UI.el('button', { text: label, onclick: () => this.showTab(key) });
        tabBar.appendChild(b); pages.appendChild(page);
        this.tabs[key] = { b: b, page: page };
      };
      this.con = UI.el('div', { class: 'console' });
      mkTab('console', '콘솔', UI.el('div', { class: 'tabpage' }, this.con));
      this.filesEl = UI.el('div', { class: 'files' });
      mkTab('files', '파일', UI.el('div', { class: 'tabpage' }, this.filesEl));
      mkTab('help', 'API 도움말', UI.el('div', { class: 'tabpage' }, this._helpEl()));
      tabBar.appendChild(UI.el('span', { class: 'grow' }));
      this.autoScroll = UI.el('input', { type: 'checkbox' }); this.autoScroll.checked = true;
      tabBar.appendChild(UI.el('label', { class: 'hint', style: 'display:flex;gap:3px;align-items:center' }, [this.autoScroll, '자동 스크롤']));
      tabBar.appendChild(UI.el('button', { text: '지우기', style: 'margin-left:6px;padding:0 8px;height:20px', onclick: () => { this.con.innerHTML = ''; this.conLines = []; } }));
      this.bottom = UI.el('div', { class: 'bottom-pane' }, [tabBar, pages]);
      const split = UI.el('div', { class: 'pane-split', title: '드래그하여 크기 조절' });
      split.addEventListener('pointerdown', (e) => {
        e.preventDefault(); split.setPointerCapture(e.pointerId);
        const y0 = e.clientY, h0 = this.bottom.offsetHeight;
        const mv = (ev) => { this.bottom.style.height = Math.max(70, h0 - (ev.clientY - y0)) + 'px'; };
        const up = () => { split.removeEventListener('pointermove', mv); split.removeEventListener('pointerup', up); };
        split.addEventListener('pointermove', mv); split.addEventListener('pointerup', up);
      });
      this.el.append(tb1, tb2, tb3, UI.el('div', { class: 'script-main' }, [this.editor.el, split, this.bottom]));
      this.showTab('console');
      this.renderFiles();
      this.updateState();
    }
    showTab(k) { for (const key of Object.keys(this.tabs)) { const t = this.tabs[key]; t.b.classList.toggle('on', key === k); t.page.classList.toggle('on', key === k); } }

    // ---------------- 실행 ----------------
    run() {
      this.editor.clearError();
      this.sim.runScript(this.editor.value, this.name);
      this.showTab('console');
    }
    updateState() {
      const rt = this.sim.runtime, paused = this.sim.paused;
      let st = rt.state, cls = st;
      if (paused) { st = 'PAUSED' + (rt.state === 'running' ? ' (running)' : ''); cls = 'paused'; }
      else if (this._waitLbl) st = 'RUNNING · ' + this._waitLbl;
      this.statePill.textContent = st.toUpperCase();
      this.statePill.className = 'statepill ' + cls;
      this.bPause.textContent = paused ? '▶ 재개' : '⏸ 일시정지';
      this.bPause.classList.toggle('on', paused);
      this.bStop.disabled = rt.state !== 'running';
      this.bRun.textContent = rt.state === 'running' ? '↻ 재실행' : '▶ 실행';
      if (rt.state === 'error' && rt.errorInfo && rt.errorInfo.line) this.editor.setError(rt.errorInfo.line);
    }
    tick() {
      this.timeLbl.textContent = 't = ' + U.fmtSimTime(this.sim.simTime);
      // 네트워크 대기가 길어지면 상태 표시 (시뮬레이션 시계는 계속 흐르고 스크립트만 잠든 상태)
      const w = this.sim.runtime.waitInfo();
      const lbl = (w && w.ms > 400) ? ({ http: 'HTTP 응답 대기', ws_open: 'WS 연결 대기', ws_msg: 'WS 수신 대기' }[w.what] || '대기') + ' ' + (w.ms / 1000).toFixed(1) + 's' : null;
      if (lbl !== this._waitLbl) { this._waitLbl = lbl; this.updateState(); }
      this._flushConsole();
    }

    // ---------------- 콘솔 ----------------
    _log(m) {
      this.conPending.push(m);
      if (this.conPending.length > 5000) this.conPending.splice(0, this.conPending.length - 5000);
    }
    _flushConsole() {
      if (!this.conPending.length) return;
      const frag = document.createDocumentFragment();
      for (const m of this.conPending) {
        if (m.kind === 'raw') {
          // io.write: 줄바꿈 단위로 묶어서 출력
          this.conRaw += m.text;
          const parts = this.conRaw.split('\n');
          this.conRaw = parts.pop();
          for (const line of parts) frag.appendChild(this._line(line, 'out', m.t));
          continue;
        }
        frag.appendChild(this._line(m.text, m.kind, m.t));
      }
      this.conPending = [];
      this.con.appendChild(frag);
      while (this.con.childNodes.length > 3000) this.con.removeChild(this.con.firstChild);
      if (this.autoScroll.checked) { const pg = this.tabs.console.page; pg.scrollTop = pg.scrollHeight; }
    }
    _line(text, kind, t) {
      const d = UI.el('div', { class: kind });
      d.appendChild(UI.el('span', { class: 'ts', text: '[' + (t === undefined ? '' : (t * 1e3).toFixed(4).padStart(12) + ' ms') + '] ' }));
      d.appendChild(document.createTextNode(text));
      return d;
    }

    // ---------------- 파일 ----------------
    async openFromPC() {
      const f = await UI.pickFile('.lua,.txt,text/plain');
      if (!f.length) return;
      this.editor.value = f[0].text;
      this.name = f[0].name; this.nameIn.value = this.name;
      UI.toast('불러옴: ' + f[0].name);
      this.app.saveSoon();
    }
    async saveToPC() {
      const text = this.editor.value;
      if (typeof G.showSaveFilePicker === 'function') {
        try {
          const h = await G.showSaveFilePicker({ suggestedName: this.name, types: [{ description: 'Lua script', accept: { 'text/plain': ['.lua', '.txt'] } }] });
          const w = await h.createWritable(); await w.write(text); await w.close();
          this.name = h.name; this.nameIn.value = h.name;
          UI.toast('저장됨: ' + h.name);
          return;
        } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      UI.download(this.name, text);
    }
    saveToVFS() {
      this.sim.vfs.write(this.name, this.editor.value);
      UI.toast('VFS 에 저장: ' + this.name + '  (dofile/require 로 사용 가능)');
      this.showTab('files');
    }
    loadExample(i) {
      const ex = VS.EXAMPLES[i];
      if (this.sim.runtime.running) this.sim.stopScript();
      this.editor.value = ex.code;
      this.name = ex.name; this.nameIn.value = ex.name;
      if (ex.setup) this.app.applySetup(ex.setup);
      UI.toast('예제 로드: ' + ex.title + (ex.setup ? ' (권장 프로브/스코프 설정 적용) — ▶ 실행을 누르세요' : ''));
      this.app.saveSoon();
    }
    renderFiles() {
      const vfs = this.sim.vfs, el = this.filesEl;
      el.innerHTML = '';
      const bar = UI.el('div', { class: 'fbar' }, [
        UI.el('button', { text: '+ 새 파일', onclick: () => { const n = prompt('파일 이름', 'data.txt'); if (n) { if (vfs.exists(n) && !confirm('덮어쓸까요?')) return; vfs.write(n, ''); this._view(n); } } }),
        UI.el('button', { text: '⤒ PC 에서 가져오기', title: 'PC 파일을 가상 파일 시스템으로 복사', onclick: async () => { const fs = await UI.pickFile('', true); for (const f of fs) vfs.write(f.name, f.text); if (fs.length) UI.toast(fs.length + '개 파일 가져옴'); } }),
        UI.el('button', {
          text: vfs.dir ? '📁 폴더 다시 읽기' : '📁 PC 폴더 연결', title: 'File System Access API (Chrome/Edge): 연결한 폴더와 파일을 동기화합니다',
          onclick: async () => {
            try { if (vfs.dir) { const n = await vfs.syncFromDisk(); UI.toast(n + '개 파일 동기화'); } else { const nm = await vfs.mount(); UI.toast('폴더 연결: ' + nm + ' (스크립트의 파일 쓰기가 폴더에 반영됩니다)'); this.renderFiles(); } }
            catch (e) { if (!e || e.name !== 'AbortError') UI.toast(String(e.message || e), 'err'); }
          }
        }),
        vfs.dir ? UI.el('button', { text: '연결 해제', onclick: () => { vfs.unmount(); this.renderFiles(); } }) : null,
        UI.el('span', { class: 'hint', text: vfs.dir ? '연결된 폴더: ' + vfs.dirName : '브라우저 저장소(localStorage)에 보관됨' })
      ]);
      el.appendChild(bar);
      const names = vfs.list();
      if (!names.length) el.appendChild(UI.el('div', { class: 'hint', text: '파일 없음. 스크립트에서 io.open("name.txt", "w") 로 만들거나 가져오기를 사용하세요.' }));
      else {
        const t = UI.el('table');
        t.appendChild(UI.el('tr', null, [UI.el('th', { text: '이름' }), UI.el('th', { text: '크기' }), UI.el('th', { text: '' })]));
        for (const n of names) {
          t.appendChild(UI.el('tr', null, [
            UI.el('td', { class: 'mono', text: n }), UI.el('td', { text: vfs.size(n) + ' B' }),
            UI.el('td', { class: 'act' }, [
              UI.el('button', { text: '보기/편집', onclick: () => this._view(n) }),
              UI.el('button', { text: '편집기로', title: '스크립트 편집기로 열기', onclick: () => { this.editor.value = vfs.read(n); this.name = n; this.nameIn.value = n; } }),
              UI.el('button', { text: '⤓', title: '다운로드', onclick: () => UI.download(n.split('/').pop(), vfs.read(n)) }),
              UI.el('button', { text: '✕', title: '삭제', onclick: () => { if (confirm(n + ' 삭제?')) vfs.remove(n); } })
            ])
          ]));
        }
        el.appendChild(t);
      }
      this.fileView = UI.el('div', { class: 'fileview' });
      el.appendChild(this.fileView);
    }
    _view(n) {
      const vfs = this.sim.vfs;
      this.showTab('files');
      const fv = this.fileView; fv.innerHTML = ''; fv.style.display = 'block';
      const ta = UI.el('textarea'); ta.value = vfs.read(n) || '';
      fv.append(UI.el('div', { class: 'fbar' }, [UI.el('b', { class: 'mono', text: n }),
        UI.el('button', { text: '저장', onclick: () => { vfs.write(n, ta.value); UI.toast('저장: ' + n); } }),
        UI.el('button', { text: '닫기', onclick: () => { fv.style.display = 'none'; } })]), ta);
    }
    _helpEl() {
      const d = UI.el('div', { class: 'help' });
      d.appendChild(UI.el('div', { class: 'hint', html: '모든 출력 쓰기/지연/클럭은 <b>시뮬레이션 클럭</b>에 정확히 반영됩니다. 오실로스코프 획득도 같은 클럭을 사용합니다. ' +
        '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 실행, <kbd>Ctrl</kbd>+<kbd>S</kbd> 저장.' }));
      for (const [h, rows] of API_DOC) {
        d.appendChild(UI.el('h4', { text: h }));
        const t = UI.el('table');
        for (const [a, b] of rows) t.appendChild(UI.el('tr', null, [UI.el('td', { text: a }), UI.el('td', { text: b })]));
        d.appendChild(t);
      }
      return d;
    }
    save() { return { code: this.editor.value, name: this.name, clk: this.sim.board.clk, cpi: this.sim.runtime.cpi, resetOnRun: this.sim.resetOutputsOnRun }; }
    load(st) {
      if (!st) { this.editor.value = VS.EXAMPLES[0].code; this.name = VS.EXAMPLES[0].name; this.nameIn.value = this.name; return; }
      this.editor.value = st.code || '';
      this.name = st.name || 'script.lua'; this.nameIn.value = this.name;
      if (st.clk) { this.sim.board.setClock(st.clk); this.clkSel.value = String(st.clk); }
      if (st.cpi !== undefined) { this.sim.runtime.cpi = st.cpi; this.cpiSel.value = String(st.cpi); }
      if (st.resetOnRun !== undefined) { this.sim.resetOutputsOnRun = st.resetOnRun; this.resetChk.checked = st.resetOnRun; }
    }
  }

  UI.ScriptWindow = ScriptWindow;
})(window);
