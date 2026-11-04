-- PWM1 : 10 kHz, 듀티 10 % ↔ 90 % 스윕 (20 ms 마다 5 %)
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
