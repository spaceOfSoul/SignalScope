-- PWM1, PWM2 : 20 kHz, 같은 듀티 (25 → 50 → 75 → 10 %)
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
