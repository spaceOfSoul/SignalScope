-- GPIO2 로 UART 9600 bps 8N1 송신 (비트뱅잉)
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
