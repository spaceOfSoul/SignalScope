-- 명령어 실행시간 모델: Lua VM 명령어 1개 = CPI 클럭 (창 2 의 CLK / CPI 설정)
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
