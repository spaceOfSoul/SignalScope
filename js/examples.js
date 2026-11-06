/* examples.js — 예제 스크립트 (setup: 예제 로드 시 적용할 권장 프로브/스코프 설정) */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};

  VS.EXAMPLES = [
    {
      name: '00_quickstart.lua', title: '00 빠른 시작 (GPIO 토글 + PWM)',
      setup: { probes: [1, 3], tdiv: 500e-6, trig: { source: 0, slope: 'rise', level: 1.65, mode: 'auto', pos: 0.5 } },
      code: String.raw`-- 빠른 시작
--  GPIO1 : 0.5 ms 마다 토글 → 1 kHz 구형파 (소프트웨어)
--  PWM1  : 2 kHz / 25 % (하드웨어 PWM, 보드 클럭 기반)
--  DAC1  : 1.2 V 고정 출력
pwm_start(PWM1, 2000, 25)
dac_write_voltage(DAC1, 1.2)

local n = 0
for i, t in every(0.0005) do        -- 0.5 ms 주기 (드리프트 없는 주기 루프)
  gpio_toggle(GPIO1)
  n = n + 1
  if n % 2000 == 0 then              -- 1초마다 상태 출력
    local f, d = pwm_read(PWM1)
    printf("t = %.3f s | GPIO1 = %d | PWM1 = %.1f Hz, %.1f %%", t, gpio_read(GPIO1), f, d)
  end
end
`
    },
    {
      name: '01_gpio_registers.lua', title: '01 GPIO 토글 + 출력 레지스터 읽기',
      setup: { probes: [1, 2], tdiv: 1e-3, trig: { source: 0, slope: 'rise', level: 1.65, mode: 'auto', pos: 0.5 } },
      code: String.raw`-- GPIO1 / GPIO2 를 반대 위상으로 토글하고, 출력 레지스터를 읽어 검증
-- (변수 / 대입 / 산술 / 비트 연산 / 조건문 / 루프)
local half_period_ms = 1          -- 2 ms 주기 = 500 Hz
local count = 0

while true do
  local v = count % 2
  gpio_write(GPIO1, v)
  gpio_write(GPIO2, 1 - v)

  -- 출력 레지스터 값 = 실제 출력 값
  local state = (gpio_read(GPIO1) << 1) | gpio_read(GPIO2)
  if state ~= 0x2 and state ~= 0x1 then
    print("unexpected state!", state)
  end

  if count % 1000 == 0 then
    printf("[%9.3f ms] count=%-6d state=0b%d%d", millis(), count, (state >> 1) & 1, state & 1)
  end
  count = count + 1
  delay(half_period_ms)
end
`
    },
    {
      name: '02_pwm_sweep.lua', title: '02 PWM 듀티/주파수 스윕',
      setup: { probes: [3, 4], tdiv: 200e-6, trig: { source: 1, slope: 'rise', level: 1.65, mode: 'auto', pos: 0.3 } },
      code: String.raw`-- PWM1 : 10 kHz, 듀티 10 % ↔ 90 % 스윕 (20 ms 마다 5 %)
-- PWM2 : 1 kHz ↔ 5 kHz 를 200 ms 마다 전환
-- 듀티 변경 시 PWM 카운터는 계속 진행(위상 유지)한다.
pwm_start(PWM1, 10000, 10)
pwm_start(PWM2, 1000, 50)

local duty, step = 10, 5
local fast = false
local t_switch = sim_time() + 0.2

for n, t in every(0.02) do
  duty = duty + step
  if duty >= 90 or duty <= 10 then step = -step end
  pwm_set_duty(PWM1, duty)

  if t >= t_switch then
    fast = not fast
    pwm_set_freq(PWM2, fast and 5000 or 1000)
    t_switch = t + 0.2
    local f, d = pwm_read(PWM2)
    printf("PWM2 -> %.1f Hz (duty %.1f %%) | PWM1 duty = %d %%", f, d, duty)
  end
end
`
    },
    {
      name: '03_dac_waves.lua', title: '03 DAC 사인파 / 삼각파 생성',
      setup: { probes: [5, 6], tdiv: 5e-3, ch: [{ vdiv: 1, pos: -1.5 }, { vdiv: 1, pos: -3.8 }], trig: { source: 0, slope: 'rise', level: 1.65, mode: 'auto', pos: 0.5 } },
      code: String.raw`-- DAC1 : 100 Hz 사인파 (갱신율 10 kHz)
-- DAC2 : 50 Hz 삼각파 (12bit 코드, 비트 마스크)
local fs = 10000
local f_sine = 100
local tri, dir = 0, 1

for n in every(1 / fs) do
  local phase = 2 * math.pi * f_sine * (n - 1) / fs
  dac_write_voltage(DAC1, 1.65 + 1.5 * math.sin(phase))

  tri = tri + dir * 41                -- 100 스텝 상승 / 100 스텝 하강 → 20 ms
  if tri >= DAC_MAX then tri, dir = DAC_MAX, -1
  elseif tri <= 0 then tri, dir = 0, 1 end
  dac_write(DAC2, tri & 0x0FFF)
end
`
    },
    {
      name: '04_uart_bitbang.lua', title: '04 UART 비트뱅잉 (클럭 tick 정밀 타이밍)',
      setup: { probes: [2, 1], tdiv: 500e-6, trig: { source: 0, slope: 'fall', level: 1.65, mode: 'normal', pos: 0.1 } },
      code: String.raw`-- GPIO2 로 UART 9600 bps 8N1 송신 (비트뱅잉)
-- 보드 클럭 tick 기준 절대시각 대기(wait_until_clk) → 명령어 실행시간과 무관한 정확한 비트 폭
local BAUD = 9600
local TICKS = math.floor(clk_freq() / BAUD + 0.5)   -- 1 비트 = TICKS 클럭

gpio_write(GPIO2, HIGH)            -- idle = High
delay(2)

local function send_byte(b)
  local t = ticks()
  local function bit(v)
    gpio_write(GPIO2, v)
    t = t + TICKS
    wait_until_clk(t)
  end
  bit(LOW)                          -- start
  for i = 0, 7 do bit((b >> i) & 1) end   -- LSB first
  bit(HIGH)                         -- stop
end

local msg = "Hi!"
while true do
  gpio_write(GPIO1, HIGH)          -- 프레임 마커
  for c in msg:gmatch(".") do send_byte(string.byte(c)) end
  gpio_write(GPIO1, LOW)
  delay(5)
end
`
    },
    {
      name: '05_pwm_rc_dac.lua', title: '05 PWM + RC LPF = 아날로그 전압 (Peak Detect)',
      setup: {
        probes: [3, 4], filters: { 3: { type: 'LPF', R: 10000, C: 100e-9 } }, tdiv: 10e-3, acq: { mode: 'peak' },
        trig: { source: 0, slope: 'rise', level: 1.2, mode: 'normal', pos: 0.3 }
      },
      code: String.raw`-- PWM1, PWM2 : 20 kHz, 같은 듀티 (25 → 50 → 75 → 10 %)
--  · PWM1 에는 창 1 에서 LPF (R=10k, C=100n, fc≈159 Hz) 적용 → 듀티에 비례한 DC 전압
--  · PWM2 는 필터 없음 → 느린 시간축에서는 Peak Detect 로 포락선 확인 (Sample 모드는 앨리어싱)
pwm_start(PWM1, 20000, 25)
pwm_start(PWM2, 20000, 25)

local duties = { 25, 50, 75, 10 }
local i = 1
while true do
  local d = duties[i]
  pwm_set_duty(PWM1, d)
  pwm_set_duty(PWM2, d)
  printf("duty = %2d %%  → 기대 DC = %.3f V", d, VCC * d / 100)
  i = i % #duties + 1
  delay(20)
end
`
    },
    {
      name: '06_file_playback.lua', title: '06 파일 읽기/쓰기: CSV 파형 재생 + 로그',
      setup: { probes: [5, 1], tdiv: 10e-3, ch: [{ vdiv: 1, pos: -1.5 }, { vdiv: 2, pos: -3.5 }], trig: { source: 1, slope: 'rise', level: 1.65, mode: 'normal', pos: 0.05 } },
      code: String.raw`-- wave.csv (t_ms, volt) 를 읽어 DAC1 로 재생, 첫 회 결과를 log.txt 에 기록
-- 파일은 창 2 의 [파일] 탭에서 확인/편집/다운로드할 수 있다.
local fname = "wave.csv"
if not fs.exists(fname) then
  local f = assert(io.open(fname, "w"))
  f:write("# t_ms,volt\n")
  for i = 0, 99 do
    local v = (i < 50) and (math.floor(i / 10) * 0.6) or (3.0 * (99 - i) / 49)
    f:write(string.format("%d,%.3f\n", i, v))
  end
  f:close()
  print("created " .. fname)
end

local pts = {}
for line in io.lines(fname) do
  if not line:match("^#") then
    local t, v = line:match("([%d%.]+),([%d%.%-]+)")
    if t then pts[#pts + 1] = { tonumber(t), tonumber(v) } end
  end
end
printf("loaded %d points from %s", #pts, fname)

local log = assert(io.open("log.txt", "w"))
log:write("sim_time_s,dac_code,volt\n")
local rep = 0
while true do
  rep = rep + 1
  gpio_toggle(GPIO1)                 -- 반복 마커 (트리거용)
  local t0 = sim_time()
  for _, p in ipairs(pts) do
    wait_until(t0 + p[1] / 1000)
    dac_write_voltage(DAC1, p[2])
    if rep == 1 then
      local code, volt = dac_read(DAC1)
      log:write(string.format("%.6f,%d,%.4f\n", sim_time(), code, volt))
    end
  end
  if rep == 1 then log:close(); print("log.txt written") end
  wait_until(t0 + 0.1)
end
`
    },
    {
      name: '07_glitch.lua', title: '07 짧은 글리치 포착 (Peak Detect / Single)',
      setup: { probes: [1, null], tdiv: 20e-3, acq: { mode: 'sample' }, trig: { source: 0, slope: 'rise', level: 1.65, mode: 'normal', pos: 0.5 } },
      code: String.raw`-- 100 ms 마다 1 µs 폭의 펄스를 GPIO1 로 출력
-- 20 ms/div (50 kSa/s @ 10k pts) 에서 Sample 모드는 펄스를 대부분 놓친다.
--  → Acquire 를 Peak Detect 로 바꾸면 모든 펄스가 보인다.
--  → Time/div 를 줄이고 Single 로 펄스 1회 포착 / Zoom 으로 확대해 보자.
while true do
  delay(100)
  gpio_write(GPIO1, HIGH)
  delay_us(1)
  gpio_write(GPIO1, LOW)
end
`
    },
    {
      name: '08_cpu_timing.lua', title: '08 명령어 실행시간(CPI) / 클럭',
      setup: { probes: [1, 2], tdiv: 20e-6, trig: { source: 1, slope: 'rise', level: 1.65, mode: 'normal', pos: 0.1 } },
      code: String.raw`-- 명령어 실행시간 모델: Lua VM 명령어 1개 = CPI 클럭 (창 2 의 CLK / CPI 설정)
-- delay 없이 토글하면 토글 간격은 CPU 속도(명령어 수 × CPI / CLK)로 결정된다.
printf("CLK = %.0f Hz, CPI = %d  →  %.3f µs / 명령어", clk_freq(), cpi(), cpi() / clk_freq() * 1e6)

local burst = 0
while true do
  burst = burst + 1
  gpio_write(GPIO2, burst & 1)      -- 버스트 마커 (CH2 트리거)
  local t0 = ticks()
  for i = 1, 40 do
    gpio_toggle(GPIO1)               -- delay 없는 비트뱅잉
  end
  local dt = ticks() - t0
  if burst % 500 == 1 then
    printf("40 toggles: %d ticks = %.2f µs", dt, dt / clk_freq() * 1e6)
  end
  delay_us(100)
end
`
    },
    {
      name: '09_xy_lissajous.lua', title: '09 XY 모드: 리사주 도형 (DAC1 = X, DAC2 = Y)',
      setup: {
        probes: [5, 6], mode: 'xy', ch: [{ vdiv: 0.5, pos: -3.3 }, { vdiv: 0.5, pos: -3.3 }],
        xy: { sr: 1e6, rl: 5000, draw: 'persist', persist: 0.2 }
      },
      code: String.raw`-- XY 모드: 리사주(Lissajous) 도형
--  DAC1 → CH1 = X축,  DAC2 → CH2 = Y축   (창 3 ▸ Display Format = XY)
--  주파수 비 / 위상차를 2 초마다 전환: 1:1(90° → 원) → 1:2 → 3:2 → 3:4 → 1:1(45° → 타원)
--  기본 주파수 200 Hz → 모든 패턴의 반복 주기 = 5 ms = XY 궤적 길이 (1 MSa/s × 5 kpts)
--  Persistence 로 패턴 전환 시 잔상을, Zoom 으로 DAC 계단(갱신율 20 kHz)을 확인해 보자.
local fs   = 20000            -- DAC 갱신율 (Hz)
local base = 200              -- 기본 주파수 (Hz)
local A, MID = 1.5, 1.65      -- 진폭 / 중심 전압 (V)
local patterns = {            -- { X 배수, Y 배수, Y 위상(°) }
  { 1, 1, 90 }, { 1, 2, 0 }, { 3, 2, 90 }, { 3, 4, 45 }, { 1, 1, 45 }
}
local hold = 2 * fs           -- 패턴 유지 = 2 s (갱신 횟수)
local idx, k = 1, 0

local function show(p)
  printf("X : Y = %d : %d, 위상 %d°  (X %.0f Hz / Y %.0f Hz)", p[1], p[2], p[3], base * p[1], base * p[2])
end
show(patterns[idx])

for n in every(1 / fs) do
  local p = patterns[idx]
  local w = 2 * math.pi * base * k / fs
  dac_write_voltage(DAC1, MID + A * math.sin(p[1] * w))
  dac_write_voltage(DAC2, MID + A * math.sin(p[2] * w + math.rad(p[3])))
  k = k + 1
  if k >= hold then
    k = 0
    idx = idx % #patterns + 1
    show(patterns[idx])
  end
end
`
    },
    {
      name: '10_xy_rc_phase.lua', title: '10 XY 모드: RC 필터 위상 지연 (리사주 타원)',
      setup: {
        probes: [5, 6], mode: 'xy', filters: { 6: { type: 'LPF', R: 1600, C: 100e-9 } },
        ch: [{ vdiv: 0.5, pos: -3.3 }, { vdiv: 0.5, pos: -3.3 }], xy: { sr: 1e6, rl: 5000, draw: 'line' }
      },
      code: String.raw`-- XY 모드: RC 필터의 위상 지연 / 진폭 감쇠 (리사주 타원)
--  DAC1 → CH1 (X) : 원 신호 (사인파)
--  DAC2 → CH2 (Y) : 같은 사인파 → 창 1 의 DAC2 LPF (R = 1.6 kΩ, C = 100 nF, fc ≈ 995 Hz)
--  필터는 출력 핀과 Probe 사이의 독립 신호처리 단 → XY 모드에서도 동일하게 적용된다.
--  화면 하단 XY 측정줄의 Δφ, |Y|/|X| 를 이론값과 비교해 보자 (f = fc 이면 약 -45°, 0.707).
--  (두 DAC 쓰기 사이의 명령어 실행시간 수 µs 만큼 추가 위상 지연이 있다)
local fs = 50000                      -- DAC 갱신율 (Hz)
local freqs = { 1000, 300, 3000 }     -- 2 초마다 전환
local R, C = 1600, 100e-9
local fc = 1 / (2 * math.pi * R * C)
local A, MID = 1.5, 1.65
local idx, k = 1, 0
local hold = 2 * fs

local function show(f)
  local ph = -math.deg(math.atan(f / fc))
  local g = 1 / math.sqrt(1 + (f / fc) ^ 2)
  printf("f = %4d Hz : 이론 위상 %.1f°, 진폭비 %.3f  (fc = %.1f Hz)", f, ph, g, fc)
end
show(freqs[idx])

for n in every(1 / fs) do
  local v = MID + A * math.sin(2 * math.pi * freqs[idx] * k / fs)
  dac_write_voltage(DAC1, v)
  dac_write_voltage(DAC2, v)
  k = k + 1
  if k >= hold then
    k = 0
    idx = idx % #freqs + 1
    show(freqs[idx])
  end
end
`
    },
    {
      name: '11_net_http_frames.lua', title: '11 네트워크(HTTP): 서버 프레임 → XY 산점도 재생', net: true,
      setup: {
        probes: [5, 6], mode: 'xy', cpi: 0,
        ch: [{ vdiv: 0.5, pos: -3.3 }, { vdiv: 0.5, pos: -3.3 }], xy: { sr: 500e3, rl: 20000, draw: 'dot' }
      },
      code: String.raw`-- HTTP 로 서버에서 프레임(점 집합)을 받아 XY 모드 산점도로 재생
--  서버 실행 (저장소 루트에서):
--    python tools/signal_server.py --demo                      ← 데모 프레임 (의존성 없음)
--    python tools/signal_server.py --parquet points.parquet    ← parquet (pip install pyarrow numpy)
--  DAC1 → CH1 (X), DAC2 → CH2 (Y).  XY 표시: Dot, 표시 길이 rl/sr = 20000 / 500 kSa/s = 40 ms (25 fps 1 프레임)
--
--  * 시뮬레이션 시계는 네트워크와 무관하게 계속 흐른다.
--    프레임 주기마다 다음 프레임이 도착했으면 교체하고, 아직이면 이전 프레임을 계속 그린다(유지).
--  * 응답 지연은 미리 여러 프레임을 요청해 두어(AHEAD) 숨긴다. http_request() 는 즉시 반환된다.
--  * 이 예제는 CPI = 0 (이상적 0-시간 실행) 으로 설정된다: 파싱 시간 동안 빔이 멈추거나,
--    X/Y 두 DAC 쓰기 사이의 명령어 시간 때문에 엉뚱한 점(유령 점)이 찍히지 않게 하기 위함.
local BASE = "http://127.0.0.1:8000"
local AHEAD = 8                       -- 미리 요청해 둘 프레임 수

local function parse_info(s)
  local t = {}
  for k, v in s:gmatch("([%w_]+)=([^\r\n]*)") do t[k] = tonumber(v) or v end
  return t
end
local function parse_frame(s)         -- "x1,y1,x2,y2,..." → {x1, y1, x2, y2, ...}, 점 수
  local t, n = {}, 0
  for v in s:gmatch("%d+") do n = n + 1; t[n] = tonumber(v) end
  return t, n // 2
end

-- 1) 서버 정보 (연결될 때까지 1 초마다 재시도: 그동안에도 시뮬레이션은 진행)
local info
while not info do
  local body, st = http_get(BASE .. "/api/info", { timeout = 2 })
  if body and st == 200 then info = parse_info(body)
  else
    printf("서버 응답 없음 (%s) → 'python tools/signal_server.py --demo' 실행 후 자동 재시도", tostring(st))
    sleep(1)
  end
end
local FRAMES, FPS = info.frames, info.fps
printf("서버: %d 프레임, %g fps, 최대 %d 점  [%s]", FRAMES, FPS, info.max_points or 0, tostring(info.source))

-- 2) 요청 파이프라인: pending[k] = 프레임 k 요청
local pending, nreq = {}, 0
local function request_upto(last)
  while nreq <= last do
    pending[nreq] = http_request(BASE .. "/api/frame/" .. (nreq % FRAMES))
    nreq = nreq + 1
  end
end

-- 3) 재생
local FRAME_T = 1 / FPS
local cur, npts = nil, 0
local k, shown, held = 0, 0, 0
local t_frame = sim_time()
local t_report = t_frame + 5
while true do
  request_upto(k + AHEAD)
  local r = pending[k]
  if r:ready() then                   -- 도착: 다음 프레임으로 교체
    local body, st = r:result()
    pending[k] = nil
    if body and st == 200 then cur, npts = parse_frame(body)
    else printf("frame %d 실패: %s", k, tostring(st)) end
    k = k + 1; shown = shown + 1
  else
    held = held + 1                   -- 미도착: 이전 프레임 유지
  end
  t_frame = t_frame + FRAME_T
  if cur and npts > 0 then            -- 이번 프레임 시간 동안 현재 프레임을 그린다
    local t0 = sim_time()
    local dwell = (t_frame - t0) / npts
    for i = 1, npts do
      dac_write(DAC1, cur[2 * i - 1]); dac_write(DAC2, cur[2 * i])
      wait_until(t0 + i * dwell)
    end
  else
    wait_until(t_frame)
  end
  if sim_time() >= t_report then
    printf("표시 %d 프레임 (현재 #%d, %d 점), 유지(미도착) %d 회", shown, (k - 1) % FRAMES, npts, held)
    t_report = t_report + 5
  end
end
`
    },
    {
      name: '12_net_ws_stream.lua', title: '12 네트워크(WebSocket): 실시간 프레임 스트림 수신', net: true,
      setup: {
        probes: [5, 6], mode: 'xy', cpi: 0,
        ch: [{ vdiv: 0.5, pos: -3.3 }, { vdiv: 0.5, pos: -3.3 }], xy: { sr: 500e3, rl: 20000, draw: 'dot' }
      },
      code: String.raw`-- WebSocket 으로 서버가 밀어주는 실시간 프레임 스트림을 받아 XY 모드로 표시
--  서버 실행: python tools/signal_server.py --demo   (또는 --parquet ...)
--  서버는 실제 시간 기준 fps 로 프레임을 보낸다 (라이브 데이터 소스 가정).
--
--  * 시뮬레이션 시계는 계속 흐른다. 스크립트는 현재 프레임을 반복해서 그리다가,
--    한 바퀴 그릴 때마다 쌓인 메시지를 확인해 가장 최신 프레임으로 교체한다.
--    (늦게 처리해 밀린 프레임은 버림: 시뮬레이션 속도가 0.1X 처럼 느리면 많이 버려지고,
--     MAX 처럼 빠르면 같은 프레임이 여러 번 그려진다)
--  * UDP/TCP 로 데이터를 보내는 프로그램이 있다면: 서버를 --udp-port / --tcp-port 로 실행하고
--    URL 을 ws://127.0.0.1:8000/relay 로 바꾸면 받은 데이터가 메시지 그대로 전달된다.
local URL = "ws://127.0.0.1:8000/ws"

local function parse_info(s)
  local t = {}
  for k, v in s:gmatch("([%w_]+)=([^\r\n]*)") do t[k] = tonumber(v) or v end
  return t
end
local function parse_frame(s)
  local t, n = {}, 0
  for v in s:gmatch("%d+") do n = n + 1; t[n] = tonumber(v) end
  return t, n // 2
end

local ws
while not ws do
  local err
  ws, err = ws_open(URL, { timeout = 2 })
  if not ws then
    printf("WebSocket 연결 실패 (%s) → 'python tools/signal_server.py --demo' 실행 후 자동 재시도", tostring(err))
    sleep(1)
  end
end
ws:send("info")
local info = parse_info(ws:recv(2) or "")
local FPS = info.fps or 25
printf("연결됨: %s (%s fps, %s 프레임)", URL, tostring(info.fps), tostring(info.frames))
ws:send("stream 0 0")                 -- 0 번부터 끝없이 (서버 fps 로 push)

local DRAW_T = 1 / FPS                -- 한 바퀴 그리는 시간
local cur, npts = nil, 0
local recvd, skipped = 0, 0
local t_report = sim_time() + 5
while true do
  -- 쌓인 메시지 중 최신 것만 사용
  local latest, m = nil, ws:poll()
  while m do
    if latest then skipped = skipped + 1 end
    latest = m; recvd = recvd + 1
    m = ws:poll()
  end
  if latest then cur, npts = parse_frame(latest) end
  if ws:state() == "closed" then printf("연결 종료: %s", tostring(ws:error())) break end
  if cur and npts > 0 then
    local t0 = sim_time()
    local dwell = DRAW_T / npts
    for i = 1, npts do
      dac_write(DAC1, cur[2 * i - 1]); dac_write(DAC2, cur[2 * i])
      wait_until(t0 + i * dwell)
    end
  else
    sleep(DRAW_T)
  end
  if sim_time() >= t_report then
    printf("수신 %d 프레임 (버림 %d), 현재 %d 점", recvd, skipped, npts)
    t_report = t_report + 5
  end
end
`
    }
  ];
})(window);
