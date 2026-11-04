-- GPIO1 / GPIO2 를 반대 위상으로 토글하고, 출력 레지스터를 읽어 검증
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
