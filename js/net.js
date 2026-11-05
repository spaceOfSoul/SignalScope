/* net.js — 스크립트용 네트워크 계층 (HTTP fetch / WebSocket)
 *
 *  - 브라우저 네트워크는 비동기다. 요청/수신 결과는 이 계층에 쌓이고, Lua 스크립트는 다음 시뮬레이션 틱부터
 *    그 결과를 볼 수 있다 (한 번의 runtime.run() 안에서는 JS 이벤트가 처리되지 않는다).
 *  - 시뮬레이션 시계는 네트워크 대기와 무관하게 계속 흐른다. 대기 중 출력은 스크립트가 결정한다
 *    (비동기 요청 + ready()/poll() 확인, 또는 http_get()/recv() 처럼 delay() 와 같이 잠들어 기다리기).
 *  - 모든 데이터는 바이트 그대로(Uint8Array ↔ Lua string) 전달된다 → 텍스트/바이너리 모두 손실 없음.
 *  - 스크립트가 정지/종료되면 진행 중인 요청은 취소되고 열린 WebSocket 은 닫힌다 (reset).
 */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};

  const DEFAULT_NET_TIMEOUT = 15;          // HTTP 응답 제한 (실제 시간, 초). 서버가 응답하지 않을 때의 안전장치
  const MAX_REQUESTS = 4096;               // 결과를 가져가지 않은 요청 수 상한
  const WS_MAX_QUEUE_MSGS = 1000000;       // WebSocket 수신 대기열 상한 (초과 시 가장 오래된 메시지부터 버림)
  const WS_MAX_QUEUE_BYTES = 256 * 1024 * 1024;

  const enc = new TextEncoder();
  const decStrict = new TextDecoder('utf-8', { fatal: true });
  const decLoose = new TextDecoder('utf-8');

  function errText(e) {
    if (!e) return 'unknown error';
    if (e.name === 'AbortError') return 'aborted';
    return e.message || String(e);
  }

  class NetHub {
    /**
     * @param impl  { fetch, WebSocket } 대체 구현 (테스트용). 생략 시 브라우저 기본
     * @param warn  경고 출력 콜백 (text)
     */
    constructor(impl, warn) {
      this.impl = impl || {};
      this.warn = warn || (() => {});
      this.reqs = new Map();
      this.socks = new Map();
      this.nextId = 1;
      this.gen = 0;
    }
    _fetch(url, init) { return (this.impl.fetch || G.fetch.bind(G))(url, init); }
    _WS() { return this.impl.WebSocket || G.WebSocket; }

    /** 진행 중인 요청 취소 + 모든 소켓 닫기 (스크립트 정지/재시작 시) */
    reset() {
      this.gen++;
      for (const r of this.reqs.values()) { if (!r.done && r.ctrl) { try { r.ctrl.abort(); } catch (e) { /* ignore */ } } if (r.timer) clearTimeout(r.timer); }
      this.reqs.clear();
      for (const s of this.socks.values()) this._closeSock(s, 1000, 'script stopped');
      this.socks.clear();
    }

    // ---------------- HTTP ----------------
    /**
     * 요청 시작 (즉시 반환). @returns id
     * opts: { method, headers{}, body(Uint8Array|null), netTimeout(s) }
     */
    httpStart(url, opts) {
      if (this.reqs.size >= MAX_REQUESTS) throw new Error('too many pending HTTP requests (' + MAX_REQUESTS + '): result() 로 결과를 가져가거나 cancel() 하세요');
      opts = opts || {};
      const id = this.nextId++;
      const r = { id: id, url: url, done: false, ok: false, status: 0, headers: null, body: null, err: null, ctrl: null, timer: null };
      this.reqs.set(id, r);
      const method = (opts.method || 'GET').toUpperCase();
      const headers = Object.assign({}, opts.headers || {});
      const init = { method: method, headers: headers };
      if (opts.body != null && method !== 'GET' && method !== 'HEAD') {
        init.body = opts.body;
        if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'text/plain;charset=UTF-8';
      }
      if (typeof AbortController === 'function') { r.ctrl = new AbortController(); init.signal = r.ctrl.signal; }
      const to = opts.netTimeout == null ? DEFAULT_NET_TIMEOUT : +opts.netTimeout;
      let timedOut = false;
      if (to > 0 && r.ctrl) r.timer = setTimeout(() => { timedOut = true; r.ctrl.abort(); }, to * 1000);
      const finish = () => { r.done = true; if (r.timer) { clearTimeout(r.timer); r.timer = null; } r.ctrl = null; };
      let p;
      try { p = Promise.resolve(this._fetch(url, init)); } catch (e) { p = Promise.reject(e); }
      p.then(async (res) => {
        const buf = new Uint8Array(await res.arrayBuffer());
        const h = {};
        if (res.headers && typeof res.headers.forEach === 'function') res.headers.forEach((v, k) => { h[String(k).toLowerCase()] = String(v); });
        r.ok = true; r.status = res.status; r.headers = h; r.body = buf;
        finish();
      }).catch((e) => {
        r.ok = false;
        r.err = timedOut ? 'timeout (no response within ' + to + ' s real time)'
          : (e && e.name === 'TypeError') ? 'network error: ' + errText(e) + ' (서버 실행 여부 / 주소 / CORS 허용 헤더 확인)'
          : errText(e);
        finish();
      });
      return id;
    }
    httpReady(id) { const r = this.reqs.get(id); return !r || r.done; }
    /** 결과를 꺼내고 내부 사본을 해제한다. @returns {ok, status, headers, body, err} | null(미완료) */
    httpTake(id) {
      const r = this.reqs.get(id);
      if (!r) return { ok: false, err: 'unknown request (already taken or cancelled)' };
      if (!r.done) return null;
      this.reqs.delete(id);
      return r;
    }
    httpCancel(id) {
      const r = this.reqs.get(id);
      if (!r) return;
      if (!r.done && r.ctrl) { try { r.ctrl.abort(); } catch (e) { /* ignore */ } }
      if (r.timer) clearTimeout(r.timer);
      this.reqs.delete(id);
    }

    // ---------------- WebSocket ----------------
    /** 연결 시작 (즉시 반환). @returns id */
    wsOpen(url, protocols) {
      const id = this.nextId++;
      const s = { id: id, url: url, ws: null, state: 'connecting', q: [], qBytes: 0, head: 0, outbox: [], err: null, closeCode: 0, closeReason: '', dropped: 0, warned: false };
      this.socks.set(id, s);
      const WSC = this._WS();
      if (!WSC) { s.state = 'closed'; s.err = 'WebSocket is not supported in this browser'; return id; }
      let ws;
      try { ws = protocols && protocols.length ? new WSC(url, protocols) : new WSC(url); }
      catch (e) { s.state = 'closed'; s.err = errText(e); return id; }
      s.ws = ws;
      try { ws.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ }
      ws.onopen = () => {
        if (s.state !== 'connecting') return;
        s.state = 'open';
        const out = s.outbox; s.outbox = [];
        for (const m of out) { try { ws.send(m); } catch (e) { s.err = errText(e); } }
      };
      ws.onmessage = (ev) => {
        const d = ev.data;
        let u8;
        if (typeof d === 'string') u8 = enc.encode(d);
        else if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
        else if (ArrayBuffer.isView(d)) u8 = new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        else return;   // Blob 등은 binaryType 설정으로 오지 않는다
        this._enqueue(s, u8);
      };
      ws.onerror = () => { if (!s.err) s.err = s.state === 'connecting' ? 'connection failed: ' + url : 'socket error'; };
      ws.onclose = (ev) => {
        s.state = 'closed';
        s.closeCode = ev && ev.code || 0; s.closeReason = ev && ev.reason || '';
        if (!s.err && s.closeCode && s.closeCode !== 1000) s.err = 'closed (code ' + s.closeCode + (s.closeReason ? ', ' + s.closeReason : '') + ')';
        s.outbox = [];
      };
      return id;
    }
    _enqueue(s, u8) {
      s.q.push(u8); s.qBytes += u8.length;
      while ((s.q.length - s.head > WS_MAX_QUEUE_MSGS || s.qBytes > WS_MAX_QUEUE_BYTES) && s.q.length - s.head > 1) {
        s.qBytes -= s.q[s.head].length; s.q[s.head] = null; s.head++; s.dropped++;
        if (!s.warned) { s.warned = true; this.warn('WebSocket 수신 대기열이 가득 차 오래된 메시지를 버립니다 (' + s.url + '): poll()/recv() 로 더 자주 꺼내세요'); }
      }
      if (s.head > 4096 && s.head * 2 > s.q.length) { s.q = s.q.slice(s.head); s.head = 0; }
    }
    _sock(id) { const s = this.socks.get(id); if (!s) throw new Error('invalid WebSocket handle'); return s; }
    wsState(id) { const s = this.socks.get(id); return s ? s.state : 'closed'; }
    wsError(id) { const s = this.socks.get(id); return s ? s.err : 'invalid WebSocket handle'; }
    wsAvailable(id) { const s = this.socks.get(id); return s ? s.q.length - s.head : 0; }
    wsDropped(id) { const s = this.socks.get(id); return s ? s.dropped : 0; }
    /** 대기열에서 메시지 1개 꺼내기. 없으면 null */
    wsPoll(id) {
      const s = this.socks.get(id);
      if (!s || s.head >= s.q.length) return null;
      const m = s.q[s.head]; s.q[s.head] = null; s.head++; s.qBytes -= m.length;
      if (s.head === s.q.length) { s.q = []; s.head = 0; }
      return m;
    }
    /** mode: 'text' | 'binary' | 'auto'(UTF-8 로 유효하면 text 프레임, 아니면 binary 프레임) */
    wsSend(id, bytes, mode) {
      const s = this._sock(id);
      if (s.state === 'closing' || s.state === 'closed') throw new Error('WebSocket is ' + s.state + (s.err ? ' (' + s.err + ')' : ''));
      let msg;
      if (mode === 'binary') msg = bytes;
      else if (mode === 'text') msg = decLoose.decode(bytes);
      else { try { msg = decStrict.decode(bytes); } catch (e) { msg = bytes; } }
      if (s.state === 'connecting') s.outbox.push(msg);
      else s.ws.send(msg);
      return true;
    }
    wsClose(id, code, reason) {
      const s = this.socks.get(id);
      if (s) this._closeSock(s, code, reason);
    }
    _closeSock(s, code, reason) {
      if (s.state === 'closed' || s.state === 'closing') return;
      s.state = s.ws ? 'closing' : 'closed';
      s.outbox = [];
      if (s.ws) { try { s.ws.close(code || 1000, reason || ''); } catch (e) { try { s.ws.close(); } catch (e2) { /* ignore */ } } }
    }
  }

  VS.NetHub = NetHub;
  VS.NET_CONST = { DEFAULT_NET_TIMEOUT: DEFAULT_NET_TIMEOUT };
})(typeof window !== 'undefined' ? window : globalThis);
