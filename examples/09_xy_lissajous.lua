-- XY 모드: 리사주(Lissajous) 도형
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
