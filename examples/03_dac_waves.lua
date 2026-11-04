-- DAC1 : 100 Hz 사인파 (갱신율 10 kHz)
-- DAC2 : 50 Hz 삼각파 (12bit 코드, 비트 마스크)
local fs = 10000
local f_sine = 100
local tri, dir = 0, 1

for n in every(1 / fs) do
  local phase = 2 * math.pi * f_sine * (n - 1) / fs
  dac_write_voltage(DAC1, 1.65 + 1.5 * math.sin(phase))

  tri = tri + dir * 41                -- 100 스텝 상승 / 100 스텝 하강 → 20 ms
  if tri >= DAC_MAX then tri, dir = DAC_MAX, -1
  elseif tri <= 0 then tri, dir = 0, 1 end
  dac_write(DAC2, tri & 0x0FFF)
end
