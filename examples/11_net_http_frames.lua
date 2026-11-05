-- HTTP 로 서버에서 프레임(점 집합)을 받아 XY 모드 산점도로 재생
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
