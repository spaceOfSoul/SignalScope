/* lua_runtime.js — fengari(Lua 5.3) 기반 보드 스크립트 실행기
 *
 *  - 사용자 스크립트는 하나의 Lua 코루틴에서 실행되며, 시뮬레이션 엔진이 시뮬레이션 클럭에 맞춰 resume 한다.
 *  - 명령어 시간 모델: Lua VM 명령어 1개 = CPI 클럭 사이클. (CPI=0 이면 이상적 0-시간 실행)
 *    count hook(N 명령어마다)으로 경과 명령어를 누적하고, API 호출 시점에는 hook 카운터 잔량으로
 *    명령어 단위의 정확한 시각을 계산한다.
 *  - delay()/sleep() 등은 보드 클럭 엣지로 올림 정렬된 기상 시각까지 코루틴을 일시정지(yield)한다.
 *  - 출력 쓰기(_sync)는 시뮬레이션 목표 시각을 넘지 않도록 동기화되어, 이벤트가 항상 시간순으로 기록된다.
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  const F = G.fengari;
  const lua = F.lua, lauxlib = F.lauxlib, lualib = F.lualib, to_luastring = F.to_luastring;

  const HOOK_N = 1000;                 // count hook 주기 (명령어)
  const MAX_ZERO_TIME_INSTR = 2e8;      // CPI=0 일 때 시간 진행 없이 허용되는 최대 명령어 수
  const EXIT_TOKEN = '__SCRIPT_EXIT__';

  function tojs(L, i) {
    const s = lua.lua_tostring(L, i);
    return s ? F.to_jsstring(s, 0, s.length, true) : '';
  }
  function pushstr(L, s) { lua.lua_pushstring(L, to_luastring(String(s))); }
  function luaErr(L, msg) { return lauxlib.luaL_error(L, to_luastring('%s'), to_luastring(String(msg))); }

  class LuaRuntime {
    /**
     * @param board VS.board.Board
     * @param vfs   VS.VFS
     * @param host  { print(text, kind, t), onState(state) }
     */
    constructor(board, vfs, host) {
      this.board = board; this.vfs = vfs; this.host = host || {};
      this.state = 'idle';      // idle | running | done | error | stopped
      this.cpi = 1;             // Lua 명령어당 클럭 사이클 (기본 10MHz/1 → 0.1µs/명령어)
      this.L = null; this.co = null;
      this.T_target = 0; this.deadline = 0;
      this.resumeAt = 0; this.yieldKind = null;
      this.tBase = 0; this.icBase = 0; this.icTotal = 0; this.lastNow = 0;
      this.icAtAdvance = 0;
      this.startTime = 0;
      this.warned = new Set();
      this.errorInfo = null;
      this.scriptName = 'script';
      // 네트워크 (HTTP / WebSocket): 대기 중에도 시뮬레이션 시계는 계속 흐른다
      this.net = new VS.NetHub(this.host.netImpl, (text) => { if (this.host.print) this.host.print('warning: ' + text, 'warn', this.lastNow); });
      this.waitCond = null;     // 외부 이벤트 대기 { check(), deadline(sim s), what, since(real ms) }
      this.wakeResult = null;   // 대기 종료 결과 (true = 조건 충족, false = 시간 초과) → 재개 시 반환값
      this.tReached = 0;        // 직전 run() 이 도달한 시각 (= 이미 확정되어 전달된 출력의 끝)
    }
    get instrTime() { return this.cpi / this.board.clk; }
    get running() { return this.state === 'running'; }
    setCPI(cpi, Lx) {
      if (this.co) this._anchor(Lx || this.co, this._nowRaw(Lx || this.co));
      this.cpi = Math.max(0, cpi);
    }

    // ---------------- 시간 계산 ----------------
    _part(Lx) {
      const p = Lx.basehookcount - Lx.hookcount;
      return p > 0 && p <= HOOK_N ? p : 0;
    }
    _nowRaw(Lx) {
      const ic = this.icTotal + this._part(Lx);
      return this.tBase + (ic - this.icBase) * this.instrTime;
    }
    /** 현재 보드 CPU 시각 (단조 증가 보장) */
    now(Lx) {
      let t = this._nowRaw(Lx || this.co);
      if (t < this.lastNow) t = this.lastNow; else this.lastNow = t;
      return t;
    }
    _anchor(Lx, t) {
      this.icBase = this.icTotal + this._part(Lx);
      this.tBase = t;
      if (t > this.lastNow) this.lastNow = t;
      this.icAtAdvance = this.icTotal;
    }

    // ---------------- 실행 제어 ----------------
    /** 스크립트 컴파일 및 시작. 성공 시 true */
    start(source, tStart, name) {
      this.stop(null);
      this.scriptName = name || 'script';
      this.errorInfo = null;
      this.warned.clear();
      const L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(L);
      lua.lua_atnativeerror(L, (Lx) => {
        const e = lua.lua_touserdata(Lx, -1);
        pushstr(Lx, (e && e.message) ? e.message : String(e));
        return 1;
      });
      this.L = L;
      this._registerAPI(L);
      // 프렐류드
      if (lauxlib.luaL_loadbufferx(L, to_luastring(VS.LUA_PRELUDE), null, to_luastring('=prelude'), null) !== lua.LUA_OK ||
          lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
        const msg = tojs(L, -1);
        this._fail('prelude error: ' + msg, null);
        return false;
      }
      const co = lua.lua_newthread(L);
      this.coRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);  // GC 방지
      const src = to_luastring(source);
      if (lauxlib.luaL_loadbufferx(co, src, null, to_luastring('=' + this.scriptName), null) !== lua.LUA_OK) {
        const msg = tojs(co, -1);
        this._fail(msg, this._lineOf(msg));
        return false;
      }
      this.co = co;
      this.icTotal = 0; this.icBase = 0; this.icAtAdvance = 0;
      const t0 = this.board.quantizeUp(tStart);
      this.tBase = t0; this.lastNow = t0; this.resumeAt = t0; this.startTime = t0;
      this.tReached = t0; this.waitCond = null; this.wakeResult = null;
      lua.lua_sethook(co, (Lx) => this._hook(Lx), lua.LUA_MASKCOUNT, HOOK_N);
      this._setState('running');
      return true;
    }
    stop(reason) {
      if (this.L && this.co) { try { this._flushFiles(); } catch (e) { /* ignore */ } }
      const wasRunning = this.state === 'running';
      this._release();
      if (wasRunning && reason) this._setState(reason);
      else if (wasRunning) this._setState('stopped');
    }
    _setState(s) { this.state = s; if (this.host.onState) this.host.onState(s, this); }
    _fail(msg, line) {
      this.errorInfo = { message: msg, line: line };
      if (this.host.print) this.host.print(msg, 'err', this.lastNow);
      this._release();
      this._setState('error');
    }
    /** Lua 상태와 스크립트가 연 네트워크 자원(요청/소켓) 해제 */
    _release() {
      this.L = null; this.co = null;
      this.waitCond = null; this.wakeResult = null;
      try { this.net.reset(); } catch (e) { /* ignore */ }
    }
    /** 외부 이벤트 대기 정보 (UI 표시용): { what, ms } | null */
    waitInfo() {
      const w = this.waitCond;
      return (w && this.state === 'running') ? { what: w.what, ms: performance.now() - w.since } : null;
    }
    /** t 보다 엄격히 뒤의 첫 보드 클럭 엣지 */
    _edgeAfter(t) {
      const b = this.board;
      let w = b.quantizeUp(t);
      if (w <= t) w = b.quantizeUp(t + 0.5 / b.clk);
      return w;
    }
    _lineOf(msg) {
      const re = new RegExp(this.scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):');
      const m = re.exec(msg);
      return m ? parseInt(m[1], 10) : null;
    }
    _flushFiles() {
      const L = this.L;
      lua.lua_getglobal(L, to_luastring('__io_flush_all'));
      if (lua.lua_isfunction(L, -1)) lua.lua_pcall(L, 0, 0, 0); else lua.lua_pop(L, 1);
      lua.lua_settop(L, 0);
    }

    _hook(Lx) {
      this.icTotal += HOOK_N;
      if (Lx !== this.co || !lua.lua_isyieldable(Lx)) return;
      const now = this.now(Lx);
      if (now >= this.T_target) { this.resumeAt = now; this.yieldKind = 'time'; return lua.lua_yield(Lx, 0); }
      if (performance.now() > this.deadline) { this.resumeAt = now; this.yieldKind = 'budget'; return lua.lua_yield(Lx, 0); }
      if (this.instrTime === 0 && this.icTotal - this.icAtAdvance > MAX_ZERO_TIME_INSTR)
        return luaErr(Lx, 'infinite loop without delay (CPI=0: simulation time cannot advance). Add delay() or set CPI > 0.');
    }

    /**
     * T_target 까지 스크립트 실행. 실제 도달한 보드 시각을 반환
     * (실시간 예산(deadline) 초과 시 T_target 보다 작을 수 있음)
     */
    run(T_target, deadline) {
      const t = this._run(T_target, deadline);
      if (t > this.tReached) this.tReached = t;
      return t;
    }
    _run(T_target, deadline) {
      if (this.state !== 'running' || !this.co) return T_target;
      this.T_target = T_target; this.deadline = deadline;
      const co = this.co;
      for (let guard = 0; guard < 1000000; guard++) {
        if (this.waitCond) {
          // 외부 이벤트(네트워크 응답/메시지) 대기 중: 스크립트는 잠들어 있고 출력은 마지막 값을 유지한다.
          // 결과는 JS 이벤트 처리 후(다음 틱)에야 보이므로, 충족되면 이미 확정된 구간(tReached) 직후 클럭 엣지에서 깨운다.
          const w = this.waitCond;
          let ok = null;
          try { if (w.check()) ok = true; } catch (e) { ok = true; }
          if (ok === null && w.deadline <= T_target) ok = false;
          if (ok === null) return T_target;
          this.waitCond = null; this.wakeResult = ok;
          this.resumeAt = ok ? this._edgeAfter(Math.max(this.resumeAt, this.tReached)) : Math.max(this.resumeAt, this.board.quantizeUp(w.deadline));
        }
        if (this.resumeAt > T_target) return T_target;
        if (guard > 0 && performance.now() > deadline) return this.resumeAt;
        let nargs = 0;
        if (this.wakeResult !== null) {
          this._anchor(co, this.resumeAt);
          lua.lua_pushboolean(co, this.wakeResult);
          this.wakeResult = null; nargs = 1;
        }
        this.yieldKind = null;
        let st;
        try {
          st = lua.lua_resume(co, this.L, nargs);
        } catch (e) {
          this._fail('internal error: ' + (e && e.message ? e.message : e), null);
          return T_target;
        }
        if (st === lua.LUA_YIELD) {
          lua.lua_settop(co, 0);
          if (this.yieldKind === 'budget') return this.resumeAt;
          if (this.yieldKind === null) this.resumeAt = this.now(co); // 사용자 coroutine.yield() → 0-시간 양보
          continue;
        }
        if (st === lua.LUA_OK) {
          this._flushFiles();
          this._release();
          this._setState('done');
          return T_target;
        }
        // 오류
        const msg = tojs(co, -1);
        if (msg.indexOf(EXIT_TOKEN) >= 0) {
          this._flushFiles(); this._release(); this._setState('done');
          return T_target;
        }
        let tb = msg;
        try {
          lauxlib.luaL_traceback(this.L, co, to_luastring(msg), 0);
          tb = tojs(this.L, -1);
          lua.lua_pop(this.L, 1);
        } catch (e) { /* ignore */ }
        try { this._flushFiles(); } catch (e) { /* ignore */ }
        this._fail(tb, this._lineOf(msg));
        return T_target;
      }
      return T_target;
    }

    _warnOnce(key, msg) {
      if (this.warned.has(key)) return;
      this.warned.add(key);
      if (this.host.print) this.host.print(msg, 'warn', this.lastNow);
    }

    // ---------------- API 등록 ----------------
    _registerAPI(L) {
      const self = this, b = this.board, vfs = this.vfs;
      const reg = (name, fn) => {
        lua.lua_pushjsfunction(L, function (Lx) {
          try { return fn(Lx); }
          catch (e) {
            if (e instanceof Error && !(e.status !== undefined)) return luaErr(Lx, e.message);
            throw e;
          }
        });
        lua.lua_setglobal(L, to_luastring(name));
      };
      const pinArg = (Lx, i) => {
        const t = lua.lua_type(Lx, i);
        if (t === lua.LUA_TNUMBER) {
          const id = Math.round(lua.lua_tonumber(Lx, i));
          if (id >= 1 && id <= b.pins.length) return b.pins[id - 1];
        } else if (t === lua.LUA_TSTRING) {
          const p = b.byName[tojs(Lx, i).toUpperCase()];
          if (p) return p;
        }
        return lauxlib.luaL_argerror(Lx, i, to_luastring('invalid pin (use GPIO1, GPIO2, PWM1, PWM2, DAC1, DAC2)'));
      };
      const levelArg = (Lx, i) => {
        const t = lua.lua_type(Lx, i);
        if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(Lx, i) ? 1 : 0;
        if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(Lx, i) !== 0 ? 1 : 0;
        if (t === lua.LUA_TSTRING) { const s = tojs(Lx, i).toUpperCase(); return (s === 'HIGH' || s === '1' || s === 'ON') ? 1 : 0; }
        if (t === lua.LUA_TNIL || t === lua.LUA_TNONE) return 0;
        return lauxlib.luaL_argerror(Lx, i, to_luastring('level expected (HIGH/LOW, 1/0, true/false)'));
      };
      const optNum = (Lx, i) => (lua.lua_type(Lx, i) === lua.LUA_TNUMBER || lua.lua_type(Lx, i) === lua.LUA_TSTRING) ? lauxlib.luaL_checknumber(Lx, i) : null;
      const warnDisabled = (p) => { if (!p.enabled) self._warnOnce('dis' + p.id, 'warning: ' + p.name + ' is Disabled (출력 비활성: 레지스터만 갱신되고 핀은 Hi-Z)'); };
      const pushTicks = (Lx, v) => { if (Math.abs(v) < 2147483647) lua.lua_pushinteger(Lx, v); else lua.lua_pushnumber(Lx, v); };

      // ---- 시간 ----
      reg('__delay', (Lx) => {
        const sec = lauxlib.luaL_checknumber(Lx, 1);
        const now = self.now(Lx);
        const wake = b.quantizeUp(now + Math.max(0, sec));
        self._anchor(Lx, wake);
        if (Lx === self.co && wake > self.T_target && lua.lua_isyieldable(Lx)) {
          self.resumeAt = wake; self.yieldKind = 'delay';
          return lua.lua_yield(Lx, 0);
        }
        return 0;
      });
      reg('__sync', (Lx) => {
        if (Lx === self.co && lua.lua_isyieldable(Lx)) {
          // 래퍼 함수의 잔여 명령어(호출 오버헤드)까지 고려해 목표 시각을 넘기기 전에 양보
          const now = self.now(Lx);
          const margin = 16 * self.instrTime;
          if (now + margin > self.T_target) { self.resumeAt = now + margin; self.yieldKind = 'sync'; return lua.lua_yield(Lx, 0); }
        }
        return 0;
      });
      reg('sim_time', (Lx) => { lua.lua_pushnumber(Lx, self.now(Lx)); return 1; });
      reg('millis', (Lx) => { lua.lua_pushnumber(Lx, self.now(Lx) * 1e3); return 1; });
      reg('micros', (Lx) => { lua.lua_pushnumber(Lx, self.now(Lx) * 1e6); return 1; });
      reg('nanos', (Lx) => { lua.lua_pushnumber(Lx, self.now(Lx) * 1e9); return 1; });
      reg('clk', (Lx) => { pushTicks(Lx, Math.floor(self.now(Lx) * b.clk + 1e-6)); return 1; });
      reg('ticks', (Lx) => { pushTicks(Lx, Math.floor(self.now(Lx) * b.clk + 1e-6)); return 1; });
      reg('clk_freq', (Lx) => { lua.lua_pushnumber(Lx, b.clk); return 1; });
      reg('cpi', (Lx) => {
        if (lua.lua_gettop(Lx) >= 1) self.setCPI(Math.round(lauxlib.luaL_checknumber(Lx, 1)), Lx);
        lua.lua_pushinteger(Lx, self.cpi); return 1;
      });
      reg('__script_clock', (Lx) => { lua.lua_pushnumber(Lx, self.now(Lx) - self.startTime); return 1; });
      reg('__board_info', (Lx) => { lua.lua_pushnumber(Lx, b.voh); lua.lua_pushnumber(Lx, b.vref); lua.lua_pushinteger(Lx, b.dacMax); return 3; });

      // ---- GPIO ----
      reg('__gpio_write', (Lx) => {
        const p = pinArg(Lx, 1), v = levelArg(Lx, 2);
        warnDisabled(p);
        b.gpioWrite(p, v, self.now(Lx)); return 0;
      });
      reg('__gpio_toggle', (Lx) => {
        const p = pinArg(Lx, 1); warnDisabled(p);
        b.gpioToggle(p, self.now(Lx)); return 0;
      });
      reg('gpio_read', (Lx) => {
        const p = pinArg(Lx, 1);
        if (p.kind === 'dac') return luaErr(Lx, p.name + ' is a DAC pin (use dac_read)');
        lua.lua_pushinteger(Lx, p.levelAt(self.now(Lx))); return 1;
      });

      // ---- PWM ----
      reg('__pwm_start', (Lx) => {
        const p = pinArg(Lx, 1);
        const f = optNum(Lx, 2), d = optNum(Lx, 3);
        warnDisabled(p);
        b.pwmConfig(p, f, d === null ? (f === null ? null : p.pwmDutyReq) : d, true, self.now(Lx)); return 0;
      });
      reg('__pwm_freq', (Lx) => {
        const p = pinArg(Lx, 1);
        b.pwmConfig(p, lauxlib.luaL_checknumber(Lx, 2), null, false, self.now(Lx)); return 0;
      });
      reg('__pwm_duty', (Lx) => {
        const p = pinArg(Lx, 1);
        b.pwmConfig(p, null, lauxlib.luaL_checknumber(Lx, 2), false, self.now(Lx)); return 0;
      });
      reg('__pwm_stop', (Lx) => {
        const p = pinArg(Lx, 1);
        b.pwmStop(p, levelArg(Lx, 2), self.now(Lx)); return 0;
      });
      reg('pwm_read', (Lx) => {
        const p = pinArg(Lx, 1);
        if (p.kind !== 'pwm') return luaErr(Lx, p.name + ' does not support PWM');
        lua.lua_pushnumber(Lx, p.pwmFreq); lua.lua_pushnumber(Lx, p.pwmDuty);
        lua.lua_pushboolean(Lx, p.pwmOn && p.enabled); return 3;
      });

      // ---- DAC ----
      reg('__dac_write', (Lx) => {
        const p = pinArg(Lx, 1); warnDisabled(p);
        b.dacWrite(p, lauxlib.luaL_checknumber(Lx, 2), self.now(Lx)); return 0;
      });
      reg('__dac_write_v', (Lx) => {
        const p = pinArg(Lx, 1); warnDisabled(p);
        b.dacWrite(p, lauxlib.luaL_checknumber(Lx, 2) / b.vref * b.dacMax, self.now(Lx)); return 0;
      });
      reg('dac_read', (Lx) => {
        const p = pinArg(Lx, 1);
        if (p.kind !== 'dac') return luaErr(Lx, p.name + ' is not a DAC pin');
        const v = p.enabled ? p.dacVoltage : 0;
        lua.lua_pushinteger(Lx, p.dacCode); lua.lua_pushnumber(Lx, v); return 2;
      });
      reg('__analog_write', (Lx) => {
        const p = pinArg(Lx, 1), v = lauxlib.luaL_checknumber(Lx, 2), t = self.now(Lx);
        warnDisabled(p);
        if (p.kind === 'dac') b.dacWrite(p, v, t);
        else if (p.kind === 'pwm') b.pwmConfig(p, null, Math.max(0, Math.min(255, v)) / 255 * 100, true, t);
        else return luaErr(Lx, p.name + ' does not support analogWrite (use PWM1/PWM2 or DAC1/DAC2)');
        return 0;
      });

      // ---- 공통 ----
      reg('pin_voltage', (Lx) => { const p = pinArg(Lx, 1); lua.lua_pushnumber(Lx, p.voltageAt(self.now(Lx))); return 1; });
      reg('pin_enabled', (Lx) => { const p = pinArg(Lx, 1); lua.lua_pushboolean(Lx, p.enabled); return 1; });
      reg('pin_read', (Lx) => {
        const p = pinArg(Lx, 1), t = self.now(Lx);
        lua.lua_createtable(Lx, 0, 10);
        const setN = (k, v) => { lua.lua_pushnumber(Lx, v); lua.lua_setfield(Lx, -2, to_luastring(k)); };
        const setI = (k, v) => { lua.lua_pushinteger(Lx, v); lua.lua_setfield(Lx, -2, to_luastring(k)); };
        const setB = (k, v) => { lua.lua_pushboolean(Lx, v); lua.lua_setfield(Lx, -2, to_luastring(k)); };
        const setS = (k, v) => { pushstr(Lx, v); lua.lua_setfield(Lx, -2, to_luastring(k)); };
        setS('name', p.name); setS('type', p.kind); setB('enabled', p.enabled);
        setN('voltage', p.voltageAt(t));
        if (p.kind !== 'dac') setI('level', p.levelAt(t));
        if (p.kind === 'pwm') { setB('pwm', p.pwmOn); setN('freq', p.pwmFreq); setN('duty', p.pwmDuty); setI('period_ticks', p.pwmPeriodTicks); setI('high_ticks', p.pwmHighTicks); }
        if (p.kind === 'dac') { setI('code', p.dacCode); }
        return 1;
      });

      // ---- 콘솔 ----
      reg('print', (Lx) => {
        const n = lua.lua_gettop(Lx), parts = [];
        for (let i = 1; i <= n; i++) { lauxlib.luaL_tolstring(Lx, i); parts.push(tojs(Lx, -1)); lua.lua_pop(Lx, 1); }
        if (self.host.print) self.host.print(parts.join('\t'), 'out', self.now(Lx));
        return 0;
      });
      reg('__console_write', (Lx) => { if (self.host.write) self.host.write(tojs(Lx, 1), self.now(Lx)); return 0; });

      // ---- 파일 시스템 ----
      reg('__fs_read', (Lx) => {
        const s = vfs.read(tojs(Lx, 1));
        if (s === null) { lua.lua_pushnil(Lx); pushstr(Lx, 'No such file'); return 2; }
        pushstr(Lx, s); return 1;
      });
      reg('__fs_write', (Lx) => { vfs.write(tojs(Lx, 1), tojs(Lx, 2)); lua.lua_pushboolean(Lx, true); return 1; });
      reg('__fs_exists', (Lx) => { lua.lua_pushboolean(Lx, vfs.exists(tojs(Lx, 1))); return 1; });
      reg('__fs_remove', (Lx) => { lua.lua_pushboolean(Lx, vfs.remove(tojs(Lx, 1))); return 1; });
      reg('__fs_rename', (Lx) => { lua.lua_pushboolean(Lx, vfs.rename(tojs(Lx, 1), tojs(Lx, 2))); return 1; });
      reg('__fs_list', (Lx) => {
        const names = vfs.list();
        lua.lua_createtable(Lx, names.length, 0);
        names.forEach((nm, i) => { pushstr(Lx, nm); lua.lua_rawseti(Lx, -2, i + 1); });
        return 1;
      });

      // ---- 네트워크 (HTTP / WebSocket) ----
      //  데이터는 바이트 그대로 전달 (Lua string ↔ Uint8Array). 대기형 호출도 시뮬레이션 시계를 멈추지 않는다.
      const net = this.net;
      const isStr = (Lx, i) => { const t = lua.lua_type(Lx, i); return t === lua.LUA_TSTRING || t === lua.LUA_TNUMBER; };
      const bytesArg = (Lx, i) => Uint8Array.from(lua.lua_tolstring(Lx, i));
      const urlArg = (Lx, i) => {
        const u = isStr(Lx, i) ? tojs(Lx, i).trim() : '';
        if (!u) return lauxlib.luaL_argerror(Lx, i, to_luastring('URL expected'));
        return u;
      };
      const idArg = (Lx, i) => lauxlib.luaL_checkinteger(Lx, i);
      const optSec = (Lx, i) => lua.lua_type(Lx, i) === lua.LUA_TNUMBER ? lua.lua_tonumber(Lx, i) : null;
      /** { 문자열 키: 문자열 값 } 테이블 → JS 객체 */
      const strMap = (Lx, i) => {
        const o = {};
        if (lua.lua_type(Lx, i) !== lua.LUA_TTABLE) return o;
        i = lua.lua_absindex(Lx, i);
        lua.lua_pushnil(Lx);
        while (lua.lua_next(Lx, i) !== 0) {
          if (lua.lua_type(Lx, -2) === lua.LUA_TSTRING && isStr(Lx, -1)) o[tojs(Lx, -2)] = tojs(Lx, -1);
          lua.lua_pop(Lx, 1);
        }
        return o;
      };
      /** 배열 테이블 또는 문자열 → 문자열 배열 */
      const strList = (Lx, i) => {
        if (isStr(Lx, i)) return [tojs(Lx, i)];
        if (lua.lua_type(Lx, i) !== lua.LUA_TTABLE) return null;
        i = lua.lua_absindex(Lx, i);
        const out = [], n = lua.lua_rawlen(Lx, i);
        for (let k = 1; k <= n; k++) { lua.lua_rawgeti(Lx, i, k); if (isStr(Lx, -1)) out.push(tojs(Lx, -1)); lua.lua_pop(Lx, 1); }
        return out;
      };

      /** __net_wait(kind, id [, timeout(sim s)]) → true(조건 충족) | false(시간 초과).
       *  delay() 처럼 스크립트를 재우고 시뮬레이션은 계속 진행한다. */
      reg('__net_wait', (Lx) => {
        const kind = tojs(Lx, 1), id = idArg(Lx, 2), tmo = optSec(Lx, 3);
        let check;
        if (kind === 'http') check = () => net.httpReady(id);
        else if (kind === 'ws_open') check = () => net.wsState(id) !== 'connecting';
        else if (kind === 'ws_msg') check = () => net.wsAvailable(id) > 0 || net.wsState(id) === 'closed';
        else return luaErr(Lx, 'invalid wait kind: ' + kind);
        if (check()) { lua.lua_pushboolean(Lx, true); return 1; }
        if (tmo !== null && tmo <= 0) { lua.lua_pushboolean(Lx, false); return 1; }
        if (Lx !== self.co || !lua.lua_isyieldable(Lx))
          return luaErr(Lx, '네트워크 대기(http_get / req:wait / ws:recv / ws_open)는 메인 스크립트에서만 가능합니다. coroutine·콜백 안에서는 req:ready() / ws:poll() 로 확인하세요');
        const now = self.now(Lx);
        self.waitCond = { check: check, deadline: tmo === null ? Infinity : now + tmo, what: kind, since: performance.now() };
        self.resumeAt = now; self.yieldKind = 'wait';
        return lua.lua_yield(Lx, 0);
      });

      // HTTP
      reg('__http_start', (Lx) => {
        const url = urlArg(Lx, 1);
        const method = isStr(Lx, 2) ? tojs(Lx, 2) : 'GET';
        const body = isStr(Lx, 3) ? bytesArg(Lx, 3) : null;
        const id = net.httpStart(url, { method: method, body: body, headers: strMap(Lx, 4), netTimeout: optSec(Lx, 5) });
        lua.lua_pushinteger(Lx, id); return 1;
      });
      reg('__http_ready', (Lx) => { lua.lua_pushboolean(Lx, net.httpReady(idArg(Lx, 1))); return 1; });
      reg('__http_take', (Lx) => {
        const r = net.httpTake(idArg(Lx, 1));
        if (!r) { lua.lua_pushnil(Lx); pushstr(Lx, 'pending'); return 2; }
        if (!r.ok) { lua.lua_pushnil(Lx); pushstr(Lx, r.err || 'request failed'); return 2; }
        lua.lua_pushstring(Lx, r.body);
        lua.lua_pushinteger(Lx, r.status);
        const keys = Object.keys(r.headers || {});
        lua.lua_createtable(Lx, 0, keys.length);
        for (const k of keys) { pushstr(Lx, r.headers[k]); lua.lua_setfield(Lx, -2, to_luastring(k)); }
        return 3;
      });
      reg('__http_cancel', (Lx) => { net.httpCancel(idArg(Lx, 1)); return 0; });

      // WebSocket
      reg('__ws_open', (Lx) => { lua.lua_pushinteger(Lx, net.wsOpen(urlArg(Lx, 1), strList(Lx, 2))); return 1; });
      reg('__ws_state', (Lx) => { pushstr(Lx, net.wsState(idArg(Lx, 1))); return 1; });
      reg('__ws_error', (Lx) => { const e = net.wsError(idArg(Lx, 1)); if (e) pushstr(Lx, e); else lua.lua_pushnil(Lx); return 1; });
      reg('__ws_available', (Lx) => { lua.lua_pushinteger(Lx, net.wsAvailable(idArg(Lx, 1))); return 1; });
      reg('__ws_dropped', (Lx) => { lua.lua_pushinteger(Lx, net.wsDropped(idArg(Lx, 1))); return 1; });
      reg('__ws_poll', (Lx) => { const m = net.wsPoll(idArg(Lx, 1)); if (m) lua.lua_pushstring(Lx, m); else lua.lua_pushnil(Lx); return 1; });
      reg('__ws_send', (Lx) => {
        const id = idArg(Lx, 1);
        if (!isStr(Lx, 2)) return lauxlib.luaL_argerror(Lx, 2, to_luastring('string expected'));
        const mode = isStr(Lx, 3) ? tojs(Lx, 3) : 'auto';
        if (mode !== 'auto' && mode !== 'text' && mode !== 'binary') return lauxlib.luaL_argerror(Lx, 3, to_luastring('"text", "binary" or nil expected'));
        try { net.wsSend(id, bytesArg(Lx, 2), mode); }
        catch (e) { lua.lua_pushnil(Lx); pushstr(Lx, e.message || String(e)); return 2; }
        lua.lua_pushboolean(Lx, true); return 1;
      });
      reg('__ws_close', (Lx) => {
        const code = lua.lua_type(Lx, 2) === lua.LUA_TNUMBER ? lua.lua_tointeger(Lx, 2) : 1000;
        net.wsClose(idArg(Lx, 1), code, isStr(Lx, 3) ? tojs(Lx, 3) : '');
        return 0;
      });
    }
  }

  VS.LuaRuntime = LuaRuntime;
})(typeof window !== 'undefined' ? window : globalThis);
