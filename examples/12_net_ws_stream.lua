-- WebSocket 으로 서버가 밀어주는 실시간 프레임 스트림을 받아 XY 모드로 표시
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
