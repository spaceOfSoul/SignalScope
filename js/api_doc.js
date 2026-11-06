/* api_doc.js — Lua API 도움말의 내용과 렌더러. 창 2 의 API 도움말 탭과 api.html 이 함께 사용한다. */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};

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

  const HINT = '모든 출력 쓰기/지연/클럭은 <b>시뮬레이션 클럭</b>에 정확히 반영됩니다. 오실로스코프 획득도 같은 클럭을 사용합니다. ' +
    '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 실행, <kbd>Ctrl</kbd>+<kbd>S</kbd> 저장.';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** container 안에 안내문과 섹션별 항목(dt = 함수, dd = 설명)을 그린다. 배치는 CSS 가 정한다 */
  VS.renderApiDoc = function (container) {
    const hint = el('div', 'hint');
    hint.innerHTML = HINT;
    container.appendChild(hint);
    for (const [heading, rows] of API_DOC) {
      container.appendChild(el('h4', null, heading));
      const list = el('dl');
      for (const [signature, description] of rows) {
        const row = el('div', 'help-row');
        row.appendChild(el('dt', null, signature));
        row.appendChild(el('dd', null, description));
        list.appendChild(row);
      }
      container.appendChild(list);
    }
  };
})(window);
