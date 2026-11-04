-- wave.csv (t_ms, volt) 를 읽어 DAC1 로 재생, 첫 회 결과를 log.txt 에 기록
-- 파일은 창 2 의 [파일] 탭에서 확인/편집/다운로드할 수 있다.
local fname = "wave.csv"
if not fs.exists(fname) then
  local f = assert(io.open(fname, "w"))
  f:write("# t_ms,volt\n")
  for i = 0, 99 do
    local v = (i < 50) and (math.floor(i / 10) * 0.6) or (3.0 * (99 - i) / 49)
    f:write(string.format("%d,%.3f\n", i, v))
  end
  f:close()
  print("created " .. fname)
end

local pts = {}
for line in io.lines(fname) do
  if not line:match("^#") then
    local t, v = line:match("([%d%.]+),([%d%.%-]+)")
    if t then pts[#pts + 1] = { tonumber(t), tonumber(v) } end
  end
end
printf("loaded %d points from %s", #pts, fname)

local log = assert(io.open("log.txt", "w"))
log:write("sim_time_s,dac_code,volt\n")
local rep = 0
while true do
  rep = rep + 1
  gpio_toggle(GPIO1)                 -- 반복 마커 (트리거용)
  local t0 = sim_time()
  for _, p in ipairs(pts) do
    wait_until(t0 + p[1] / 1000)
    dac_write_voltage(DAC1, p[2])
    if rep == 1 then
      local code, volt = dac_read(DAC1)
      log:write(string.format("%.6f,%d,%.4f\n", sim_time(), code, volt))
    end
  end
  if rep == 1 then log:close(); print("log.txt written") end
  wait_until(t0 + 0.1)
end
