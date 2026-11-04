-- XY 모드: RC 필터의 위상 지연 / 진폭 감쇠 (리사주 타원)
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
