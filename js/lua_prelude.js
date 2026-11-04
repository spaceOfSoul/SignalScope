/* lua_prelude.js — 스크립트 실행 전에 로드되는 Lua 프렐류드 (API 별칭/래퍼, io 라이브러리, require 등) */
(function (G) {
  'use strict';
  const VS = G.VS = G.VS || {};
  VS.LUA_PRELUDE = String.raw`
local _sync, _delay = __sync, __delay
local select, type, tostring, error, setmetatable, getmetatable, tonumber, pairs =
      select, type, tostring, error, setmetatable, getmetatable, tonumber, pairs

-- ===== 핀/상수 =====
GPIO1, GPIO2, PWM1, PWM2, DAC1, DAC2 = 1, 2, 3, 4, 5, 6
HIGH, LOW = 1, 0
VCC, VREF, DAC_MAX = __board_info()

-- ===== 시간 / 클럭 =====
function delay(ms)     return _delay((ms or 0) / 1000) end
delay_ms = delay
function delay_us(us)  return _delay((us or 0) / 1e6) end
function delay_ns(ns)  return _delay((ns or 0) / 1e9) end
function sleep(s)      return _delay(s or 0) end
function delay_clk(n)  return _delay((n or 0) / clk_freq()) end
wait_clk = delay_clk
function wait_until(t) local d = t - sim_time(); if d > 0 then return _delay(d) end end
function wait_until_clk(tick) return wait_until(tick / clk_freq()) end
-- 드리프트 없는 주기 루프:  for n, t in every(0.001) do ... end
function every(period, count)
  local t0, n = sim_time(), 0
  return function()
    if count and n >= count then return nil end
    if n > 0 then wait_until(t0 + n * period) end
    n = n + 1
    return n, sim_time()
  end
end

-- ===== 출력 제어 (모든 출력 쓰기는 시뮬레이션 클럭에 동기화) =====
function gpio_write(p, v)      _sync() return __gpio_write(p, v) end
function gpio_toggle(p)        _sync() return __gpio_toggle(p) end
function pwm_start(p, f, d)    _sync() return __pwm_start(p, f, d) end
function pwm_set_freq(p, f)    _sync() return __pwm_freq(p, f) end
function pwm_set_duty(p, d)    _sync() return __pwm_duty(p, d) end
function pwm_stop(p, lvl)      _sync() return __pwm_stop(p, lvl) end
function dac_write(p, c)       _sync() return __dac_write(p, c) end
function dac_write_voltage(p, v) _sync() return __dac_write_v(p, v) end
function analogWrite(p, v)     _sync() return __analog_write(p, v) end
pwm = pwm_start
dac_write_v = dac_write_voltage
digitalWrite = gpio_write
digitalRead = gpio_read
function printf(fmt, ...) return print(string.format(fmt, ...)) end

-- ===== io 라이브러리 (가상 파일 시스템) =====
do
  local fs_read, fs_write, fs_exists, fs_list, fs_remove, fs_rename, cwrite =
        __fs_read, __fs_write, __fs_exists, __fs_list, __fs_remove, __fs_rename, __console_write
  local sfind, ssub, smatch, sformat, concat, unpack, pack =
        string.find, string.sub, string.match, string.format, table.concat, table.unpack, table.pack
  local mtype = math.type
  local open_files = {}
  local F = {}
  F.__index = F
  F.__name = "FILE*"
  F.__tostring = function(f) if f._closed then return "file (closed)" end return "file (" .. f._name .. ")" end

  local function content(f)
    local p = f._parts
    if #p > 0 then f._buf = f._buf .. concat(p); f._parts = {} end
    return f._buf
  end
  local function put(f, s)
    if f._append then f._pos = f._len + 1 end
    if f._pos == f._len + 1 then
      local p = f._parts; p[#p + 1] = s
      f._len = f._len + #s; f._pos = f._len + 1
    else
      local b = content(f)
      if f._pos > #b + 1 then b = b .. string.rep("\0", f._pos - #b - 1) end
      b = ssub(b, 1, f._pos - 1) .. s .. ssub(b, f._pos + #s)
      f._buf = b; f._len = #b; f._pos = f._pos + #s
    end
    f._dirty = true
  end
  local function checkf(f, fname)
    if getmetatable(f) ~= F then error("bad argument #1 to '" .. fname .. "' (FILE* expected)", 3) end
    if f._closed then error("attempt to use a closed file", 3) end
  end
  local NUMPATS = { "^[%+%-]?0[xX][%x%.]+[pP]?[%+%-]?%d*", "^[%+%-]?%d+%.?%d*[eE][%+%-]?%d+", "^[%+%-]?%.%d+[eE][%+%-]?%d+",
                    "^[%+%-]?%d+%.?%d*", "^[%+%-]?%.%d+" }
  local function read1(f, fmt)
    local b = content(f)
    local pos = f._pos
    if type(fmt) == "number" then
      if pos > #b then return nil end
      local s = ssub(b, pos, pos + fmt - 1)
      f._pos = pos + #s
      return s
    end
    fmt = tostring(fmt):gsub("^%*", "")
    local c = ssub(fmt, 1, 1)
    if c == "l" or c == "L" then
      if pos > #b then return nil end
      local e = sfind(b, "\n", pos, true)
      local line
      if e then line = ssub(b, pos, (c == "L") and e or e - 1); f._pos = e + 1
      else line = ssub(b, pos); f._pos = #b + 1 end
      if c == "l" and ssub(line, -1) == "\r" then line = ssub(line, 1, -2) end
      return line
    elseif c == "a" then
      local s = ssub(b, pos); f._pos = #b + 1
      return s
    elseif c == "n" then
      local _, e = sfind(b, "^%s*", pos)
      local p2 = e + 1
      for _, pat in ipairs(NUMPATS) do
        local tok = smatch(b, pat, p2)
        if tok then
          local v = tonumber(tok)
          if v then f._pos = p2 + #tok; return v end
        end
      end
      return nil
    end
    error("bad argument #1 to 'read' (invalid format)", 3)
  end
  function F:read(...)
    checkf(self, "read")
    if not self._readable then return nil, "file not opened for reading", 9 end
    local n = select('#', ...)
    if n == 0 then return read1(self, "l") end
    local res = {}
    for i = 1, n do
      local v = read1(self, (select(i, ...)))
      res[i] = v
      if v == nil then return unpack(res, 1, i) end
    end
    return unpack(res, 1, n)
  end
  function F:lines(...)
    checkf(self, "lines")
    local fmts = pack(...)
    return function()
      if self._closed then error("file is already closed", 2) end
      if fmts.n == 0 then return read1(self, "l") end
      return self:read(unpack(fmts, 1, fmts.n))
    end
  end
  function F:write(...)
    checkf(self, "write")
    if not self._writable then return nil, "file not opened for writing", 9 end
    for i = 1, select('#', ...) do
      local v = select(i, ...)
      local tv = type(v)
      if tv == "number" then v = (mtype(v) == "integer") and sformat("%d", v) or sformat("%.14g", v)
      elseif tv ~= "string" then error("bad argument #" .. i .. " to 'write' (string expected, got " .. tv .. ")", 2) end
      put(self, v)
    end
    return self
  end
  function F:seek(whence, off)
    checkf(self, "seek")
    whence = whence or "cur"; off = off or 0
    local base = (whence == "set") and 0 or (whence == "end") and self._len or (self._pos - 1)
    local np = base + off
    if np < 0 then return nil, "Invalid argument", 22 end
    self._pos = np + 1
    return np
  end
  function F:flush()
    checkf(self, "flush")
    if self._writable and self._dirty then fs_write(self._name, content(self)); self._dirty = false end
    return self
  end
  function F:close()
    checkf(self, "close")
    if self._writable and self._dirty then fs_write(self._name, content(self)); self._dirty = false end
    self._closed = true
    open_files[self] = nil
    return true
  end
  function F:setvbuf() return true end

  io = {}
  function io.open(name, mode)
    name = tostring(name); mode = mode or "r"
    local m, plus = smatch(mode, "^([rwa])(%+?)b?$")
    if not m then error("bad argument #2 to 'open' (invalid mode '" .. mode .. "')", 2) end
    plus = (plus == "+")
    local f = setmetatable({ _name = name, _parts = {}, _pos = 1, _buf = "", _len = 0 }, F)
    if m == "r" then
      local s = fs_read(name)
      if not s then return nil, name .. ": No such file or directory", 2 end
      f._buf = s; f._len = #s; f._readable = true; f._writable = plus
    elseif m == "w" then
      fs_write(name, "")
      f._writable = true; f._readable = plus
    else
      local s = fs_read(name)
      if not s then s = ""; fs_write(name, "") end
      f._buf = s; f._len = #s; f._pos = #s + 1
      f._writable = true; f._readable = plus; f._append = true
    end
    open_files[f] = true
    return f
  end
  function io.lines(name, ...)
    if name == nil then error("io.lines() without a file name is not supported (no stdin)", 2) end
    local f, err = io.open(name, "r")
    if not f then error(err, 2) end
    local fmts = pack(...)
    return function()
      if f._closed then return nil end
      local v
      if fmts.n == 0 then v = read1(f, "l") else v = f:read(unpack(fmts, 1, fmts.n)) end
      if v == nil then f:close() end
      return v
    end
  end
  function io.write(...)
    for i = 1, select('#', ...) do cwrite(tostring((select(i, ...)))) end
    return io
  end
  function io.read() return nil end
  function io.close(f) if f then return f:close() end return true end
  function io.type(f)
    if getmetatable(f) == F then return f._closed and "closed file" or "file" end
    return nil
  end
  local con = { write = function(self, ...) io.write(...) return self end,
                flush = function(self) return self end, close = function() return true end,
                setvbuf = function() return true end, lines = function() return function() return nil end end,
                read = function() return nil end }
  io.stdout = setmetatable({}, { __index = con, __tostring = function() return "file (console)" end })
  io.stderr = io.stdout
  io.stdin = io.stdout
  io.output = function() return io.stdout end
  io.input = function() return io.stdin end
  function __io_flush_all()
    for f in pairs(open_files) do
      if not f._closed and f._writable and f._dirty then fs_write(f._name, content(f)); f._dirty = false end
    end
  end

  fs = {
    list = function() return fs_list() end,
    exists = function(n) return fs_exists(n) end,
    remove = function(n) return fs_remove(n) end,
    rename = function(a, b) return fs_rename(a, b) end,
    read = function(n) return fs_read(n) end,
    write = function(n, s) return fs_write(n, tostring(s)) end,
    append = function(n, s) return fs_write(n, (fs_read(n) or "") .. tostring(s)) end,
  }
  os.remove = function(n)
    if fs_remove(n) then return true end
    return nil, tostring(n) .. ": No such file or directory", 2
  end
  os.rename = function(a, b)
    if fs_rename(a, b) then return true end
    return nil, tostring(a) .. ": No such file or directory", 2
  end
  os.exit = function() error("__SCRIPT_EXIT__", 0) end
  os.getenv = function() return nil end
  os.clock = function() return __script_clock() end
  os.tmpname = function() return "tmp_" .. tostring(math.random(100000, 999999)) .. ".txt" end
  os.execute = nil

  function loadfile(name, mode, env)
    local s = fs_read(name)
    if not s then return nil, "cannot open " .. tostring(name) end
    if env ~= nil then return load(s, "@" .. name, mode, env) end
    return load(s, "@" .. name, mode)
  end
  function dofile(name)
    local f, err = loadfile(name)
    if not f then error(err, 2) end
    return f()
  end
  if package then
    package.path = "?.lua;?/init.lua;lib/?.lua"
    package.cpath = ""
    local preload_searcher = package.searchers[1]
    package.searchers = { preload_searcher, function(modname)
      local base = modname:gsub("%.", "/")
      local tried = {}
      for pat in package.path:gmatch("[^;]+") do
        local fname = pat:gsub("%?", base)
        local s = fs_read(fname)
        if s then
          local chunk, err = load(s, "@" .. fname)
          if not chunk then error("error loading module '" .. modname .. "' from file '" .. fname .. "':\n\t" .. err, 2) end
          return chunk, fname
        end
        tried[#tried + 1] = "\n\tno file '" .. fname .. "'"
      end
      return concat(tried)
    end }
  end
end
`;
})(typeof window !== 'undefined' ? window : globalThis);
