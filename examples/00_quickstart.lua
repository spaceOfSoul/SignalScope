-- 빠른 시작
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
