# SignalScope

GPIO / GPIO_PWM / DAC 출력 신호를 **가상 오실로스코프로 측정하는 동작을 모사**하는 GUI 프로그램입니다.
`요구사항목록/요구사항.md` 에 정의된 3개의 창(핀/프로브 설정, 출력 제어 스크립트, 오실로스코프)을 하나의 웹 페이지 안에서
드래그/크기조절이 가능한 창으로 제공하며, `요구사항목록/요구사항_2.md` 의 **XY Mode**(X = CH1 전압, Y = CH2 전압)를 지원합니다.

기존 요구사항 외 추가한 기능의 구현 기록은 [추가구현사항목록](추가구현사항목록/README.md)에 보관합니다. 네트워크 입력·데이터 서버·중계·Parquet 연동의 구현 범위와 브랜치 반영 상태는 [ADD-001](추가구현사항목록/001_네트워크_입력.md)을 참고하세요.

- 구현: HTML + JavaScript (빌드/설치 불필요), 스크립트 엔진은 **Lua 5.3** ([fengari](https://github.com/fengari-lua/fengari), MIT)
- 브라우저: Chrome / Edge 권장 (Firefox 도 동작, 단 "PC 폴더 연결" 기능은 Chrome/Edge 전용)

## 실행 방법

1. `index.html` 을 브라우저로 엽니다 (더블클릭). 서버가 필요 없습니다.
2. 처음 실행 시 빠른 시작 예제(`00_quickstart.lua`)가 자동 실행되어 CH1(GPIO1), CH2(PWM1) 파형이 표시됩니다.
3. 설정(핀 필터/프로브, 스크립트, 스코프 설정, 창 배치)은 브라우저에 자동 저장되어 다음 실행 시 복원됩니다.

> 로컬 서버로 열고 싶다면: `python -m http.server` 실행 후 `http://localhost:8000/` 접속.
> 외부 데이터(HTTP / WebSocket)를 스크립트에서 받으려면 앱과 별도로 [네트워크](#네트워크-http--websocket) 의 데이터 서버 `tools/signal_server.py` 를 실행하세요.

## 화면 구성

| 창 | 내용 |
|---|---|
| **창 1 · 출력 Pin 설정 및 Probe 배치** | 보드 다이어그램 + 핀 표. 핀(다이어그램 또는 체크박스)을 클릭/체크하여 Probe 지정(최대 2개 → CH1, CH2). 핀별 드롭다운: **Filter**(사용안함 / LPF(R-C) / HPF(C-R), 기본 "사용안함", R·C 값 입력 → τ, fc 표시), **Enable/Disable**(기본 Enable). 현재 출력값과 LED 표시. |
| **창 2 · 출력 제어** | Lua 스크립트 편집기(구문 강조/줄 번호/오류 줄 표시), 실행/정지, **시뮬레이션 일시정지·재개, 속도(0.1X/1X/10X/MAX)**, 보드 클럭(CLK)·명령어 사이클(CPI) 설정, 콘솔, 파일 관리(가상 파일 시스템/PC 폴더 연결), 네트워크(HTTP fetch / WebSocket), API 도움말, 예제. |
| **창 3 · 오실로스코프** | 10×8 division 화면, CH1(노랑)/CH2(청록), **Display Format (Y-T / XY)**, XY / Vertical / Horizontal / Trigger / Acquire / Display 패널, 자동 측정(Freq, Period, Duty, Vpp, Vmax, Vmin, Vavg, Vrms), CSV 저장. |

상단 바: 창 표시/숨김, 배치 초기화, 스크립트 상태, 시뮬레이션 상태(RUNNING/PAUSED)·Pause·속도, 시뮬레이션 시각과 실제 속도.
단축키: <kbd>Space</kbd> 시뮬레이션 일시정지/재개, 편집기에서 <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 실행, <kbd>Ctrl</kbd>+<kbd>S</kbd> 저장.

### 오실로스코프 조작

- **노브**: 마우스 휠 / 세로 드래그 / ◀▶ 버튼으로 조절, <kbd>Shift</kbd> = 미세 조절, 더블클릭 = 기본값.
  (Volts/div, Time/div 는 실제 계측기처럼 시계방향 = 확대)
- **화면**: 휠 = Zoom, 드래그 = Horizontal Position(Zoom 시 Zoom 위치), 우측 **T** 마커 드래그 = 트리거 레벨,
  좌측 채널 마커 드래그 = 수직 위치, 오버뷰 클릭 = Zoom 위치 이동, Zoom 창 더블클릭 = Zoom 해제.
- **RUN/STOP**: 계측기 획득만 시작/중지 (보드 시뮬레이션은 계속). **SINGLE**: 트리거 1회 후 정지.
  **AUTOSET**: 최근 신호로 V/div·Time/div·트리거 자동 설정. **FORCE**: 강제 트리거.
- **Display ▸ ⤓ CSV 저장**: 현재 획득된 파형을 CSV 로 다운로드 (Timestamp = Simulation Clock 시각).
  Y-T: `Timestamp, CH1, CH2` (Peak Detect 는 Min/Max), XY: `Timestamp, CH1 Voltage (X), CH2 Voltage (Y)`.

### XY 모드 조작

- **Display Format ▸ XY** 로 전환 (Y-T 로 되돌리면 기존 트리거 획득 재개). X축 = CH1, Y축 = CH2.
- **XY Mode 패널**: Draw(**Line / Dot / Persistence**), Persist(잔상 유지 50 ms ~ 10 s 또는 ∞ 누적, 잔상 지우기),
  Rate(XY Sample Rate), Points(궤적 점 수 → 궤적 길이 = Points / Rate), Zoom ×, Zoom 중심 → 0, Position → 0.
- **Vertical** 의 CH1 Volts/div·Position 은 X축, CH2 는 Y축에 각각 독립 적용. Probe/Coupling 도 그대로 적용.
- **화면**: 휠 = Zoom(마우스 위치 고정), 드래그 = X/Y Position 이동(Zoom 중에는 확대 영역 이동),
  좌측 **2** 마커 = CH2(Y) 0 V 위치, 하단 **1** 마커 = CH1(X) 0 V 위치(드래그), 우상단 오버뷰 클릭 = Zoom 위치, 더블클릭 = Zoom 해제.
- **RUN/STOP**: 궤적 획득만 중지/재개(재개 시 새 궤적), **SINGLE**: Points 만큼 1회 획득 후 정지,
  **AUTOSET**: X/Y V/div·Position 을 신호 범위에, 궤적 길이를 신호 주기(느린 신호 2 주기 이상)에 맞춤.
- Horizontal(Time/div), Trigger(Edge), Acquire(Peak/Average), FORCE 는 XY 모드에서 비활성(회색 표시).

## 요구사항 대응

### 창 1
| 요구사항 | 구현 |
|---|---|
| 6개 출력 핀(GPIO×2, PWM GPIO×2, DAC×2) | `GPIO1, GPIO2, PWM1, PWM2, DAC1, DAC2` |
| 최대 2개 Probe 지정 (클릭/체크) | 다이어그램 클릭 또는 체크박스. 3번째 지정 시 거부 안내. 먼저 빈 채널(CH1→CH2)에 연결, `⇄` 로 교환 |
| Filter 드롭다운 (LPF/HPF/사용안함, 기본 사용안함) | R-C LPF / C-R HPF, R·C 값 설정 |
| Enable/Disable 드롭다운 (기본 Enable) | Disable = 출력 드라이버 off(Hi-Z, 0 V). 레지스터 쓰기는 보관되며 경고 표시 |

### 창 2 (Lua 스크립트)
| 요구사항 | 구현 |
|---|---|
| GPIO High/Low | `gpio_write(pin, HIGH/LOW)`, `gpio_toggle`, `digitalWrite` |
| PWM 제어 | `pwm_start(pin, freq, duty%)`, `pwm_set_freq`, `pwm_set_duty`, `pwm_stop`, `analogWrite(PWMx, 0..255)` |
| DAC AnalogWrite | `analogWrite(DACx, 0..4095)`, `dac_write`, `dac_write_voltage` |
| loop + 동기화용 clk | Lua `while/for/repeat`, `every(period)`; 보드 클럭 `clk_freq()`, `ticks()`, `delay_clk(n)`, `wait_until_clk(tick)`; 모든 출력은 클럭 엣지에 정렬, PWM 주기/듀티는 클럭 tick 으로 양자화 |
| 출력 레지스터 읽기 (= 실제 출력) | `gpio_read`, `pwm_read`, `dac_read`, `pin_read`, `pin_voltage` |
| 변수 / 대입·산술·비트 연산 / 조건문 | Lua 5.3 (`& | ~ << >> //` 지원, 정수 32bit) |
| 파일 load, read/write | 편집기 **📂 열기/💾 저장**(PC 파일), 스크립트의 `io.open/io.lines/file:read/write/seek`, `fs.*`, `dofile/loadfile/require`. 파일은 가상 파일 시스템(브라우저 저장소)에 보관되며 **PC 폴더 연결** 시 실제 폴더에 기록 |
| (확장) 외부 데이터 수신 | `http_request/http_get/http_post`, `ws_open` → `ws:send/recv/poll` (아래 [네트워크](#네트워크-http--websocket)) |

### 창 3 (오실로스코프)
| 요구사항 | 구현 |
|---|---|
| 2채널 동시 표시, CH1 노랑 / CH2 청록, ON/OFF | ✔ |
| X=시간, Y=전압, 10×8 Division | ✔ (0.2 div 미세 눈금) |
| 창 1 Probe ↔ 채널 연결, 스크립트와 동기화 | 동일 Simulation Clock 사용 |
| GPIO/PWM/DAC 신호 특성, LPF/HPF 반영 | 핀 출력 → 필터 단 → 프로브 → 커플링 → ADC 신호 경로 |
| Time/Div (ns~s), Horizontal Position, Zoom | 1 ns/div ~ 50 s/div, Position(트리거 기준 지연), Zoom ×2 ~ ×(Record Length/10) (저장 레코드 재사용, 오버뷰+확대 화면) |
| V/div, Position(Offset), Probe 1X/10X, DC/AC Coupling, GND 기준 표시 | ✔ (+ GND 커플링). 10X 시 V/div 범위 ×10 및 프로브 입력 환산 잡음 증가 |
| Edge 트리거 (CH1/CH2, Rising/Falling, Level) | 연속 신호에서 해석적 교차 탐색 → 서브샘플 정확도 |
| Trigger Mode Auto / Normal / Single | ✔ |
| Trigger Position (Pre/Post 비율) | Pre-Trigger 노브 (0~100%) |
| Level/Position GUI 확인 | 우측 T 마커(+변경 시 점선), 상단 트리거 위치 마커, 하단 판독 |
| Run/Stop, Single | ✔ |
| Sample / Peak Detect / Average | Peak Detect 는 샘플 간격 내 실제 최소/최대(엣지 해석) 보존, Average 2~256회 |
| Sample Rate, Record Length, 관계 일관성 | `Record Length = Sample Rate × 10 div × Time/div` 항상 유지. RL 우선(Auto) / SR 우선(Manual), 최대 10 GSa/s · 1 Mpts 제한 시 안내 |
| 획득 데이터 별도 보관 (Zoom 시 원본 유지) | 레코드는 화면과 독립 보관, Stop 후에도 Zoom/Position/V/div 변경 시 원본으로 재표시 |
| Simulation Clock, 속도(0.1X/1X/10X/MAX), Pause/Resume | ✔ |
| 렌더링 주기와 시뮬레이션 주기 독립 | 시뮬레이션 루프(≈4 ms, `setTimeout`) ↔ 렌더링(`requestAnimationFrame`) 분리 |
| 높은 PWM 주파수/짧은 펄스 일관 표현 | 이벤트/해석 기반 계산 (샘플 단위 적분 없음), 픽셀 열 min/max 표시 |

### 요구사항_2 · XY Mode
| 요구사항 | 구현 |
|---|---|
| 1. Y-T 외에 XY Mode (X = CH1 전압, Y = CH2 전압) | Display Format ▸ `Y-T` / `XY` |
| 2. Y-T / XY 전환 | 세그먼트 버튼 (설정 저장/복원 포함). 전환 시 진행 중 획득을 버리고 새 모드로 획득 |
| 3. 동일 Simulation Timestamp 의 CH1, CH2 전압 → 하나의 좌표 | Simulation Clock 격자 `t_k = k / fs` 에서 두 채널을 **같은 시각 배열**로 샘플링해 (X, Y) 쌍으로 저장 |
| 4. 시간 순서대로 연결한 궤적 | 링버퍼의 최근 `Points` 개를 시간 순으로 연결 (궤적 길이 = Points / Rate) + 최신 샘플(빔) 표시 |
| 5. 각 축 Volt/Div, Position 독립 설정 | CH1 → X축, CH2 → Y축 (노브 / 화면 마커 드래그). 획득 데이터는 전압으로 보관되어 Stop 후에도 재매핑 |
| 6. Line / Dot / Persistence | Line = 선 연결, Dot = 점, Persistence = 픽셀별 마지막 샘플 시각을 기록해 **Simulation Clock 기준**으로 감쇠(50 ms ~ 10 s), ∞ = 무한 누적(히트 밀도 밝기) |
| 7. Run / Stop, Zoom | RUN/STOP/SINGLE, Zoom ×2 ~ ×50 (휠/노브/드래그, 오버뷰 + 확대 영역 표시, 눈금은 확대된 V/div 로 표기) |
| 8. Time/Div, Edge Trigger 비활성, 획득은 Simulation Clock | Horizontal·Trigger·Acquire 패널과 FORCE 비활성. 획득은 시뮬레이션 틱마다 `(t_prev, t_now]` 의 격자 시각을 연속 샘플링 |
| 9. Probe / Filter / Coupling 동일 적용 | Y-T 와 같은 채널 신호 체인(핀 필터 → 프로브 → 커플링 → ADC)의 Timeline 을 샘플링 |
| 10. X/Y 전압 눈금, 0 V 기준선 | 축별 전압 눈금(채널 색), 0 V 점선(CH1 세로선 / CH2 가로선), 원점 `0,0` 표시, 화면 밖이면 마커에 방향 화살표 |
| 11. CSV 저장 (Timestamp, CH1 X, CH2 Y) | Display ▸ ⤓ CSV 저장 → `xy_t<시각>s.csv` (Y-T 모드에서도 CSV 저장 지원) |
| 12. Probe 미연결 / 비활성 시 표시 중단 + GUI 표시 | 두 채널 중 하나라도 Probe 미연결, 연결 핀 Disable, 채널 OFF 이면 획득·표시 중단 → 화면 경고 박스, 상태 `Hold`, XY 패널 사유 표시. 회복 시 새 궤적으로 재개 |
| 추가 명시: 샘플링 시점 일치 | 두 채널은 같은 `ta, dt` 로 샘플링 (테스트: 동시에 반대로 전환되는 두 GPIO 의 XY 점에 (H,H)/(L,L) 이 하나도 없음, 0.5 µs 어긋나게 샘플링하면 검출됨) |

XY 측정: 채널별 Vpp/Vmax/Vmin/Vavg/Vrms/Freq, 두 채널 주파수가 같으면 기본파 **위상차 Δφ(CH2−CH1)** 와 **진폭비 |Y|/|X|**
(정수 주기 구간 DFT), 다르면 **주파수비 Y/X** 를 표시합니다.

### 추가 명시
1. **시뮬레이션과 GUI 렌더링 분리** — 100 kHz PWM 도 내부에서는 모든 전환 시점이 해석적으로 계산됩니다(주기 사상 고정점으로 k주기 점프).
2. **Stop ≠ Pause** — 오실로스코프 STOP 은 획득만 중단(보드/시뮬레이션 시간은 진행), Simulation Pause 는 보드와 계측기의 가상 시간 자체를 정지합니다.
3. **필터 = 출력 핀과 Probe 사이의 독립 신호처리 단** — `PinFilter` 클래스가 핀별 필터 상태를 프로브 연결과 무관하게 유지합니다.

## 시뮬레이션 모델

```
 Lua 스크립트 ──(명령어/딜레이 시각)──▶ 보드 레지스터 ──raw 이벤트──▶ PinFilter(RC) ──▶ Probe ──▶ 커플링(DC/AC/GND) ──▶ ADC(8bit, 잡음) ──▶ 레코드
        ▲                                                                                                      │
        └──────────────────────────── 동일한 Simulation Clock (simTime) ───────────────────────────────────────┘
```

- **Simulation Clock**: 실제 시간과 독립. 한 틱마다 ① GUI 변경 적용 → ② 스크립트를 목표 시각까지 실행 →
  ③ 이벤트를 필터/스코프 입력으로 전달 → ④ 트리거 탐색·레코드 생성. 실시간 예산을 넘으면 시뮬레이션이 자동으로 느려지며
  실제 속도가 표시됩니다.
- **보드 클럭 / 명령어 시간**: 기본 CLK 10 MHz, CPI 1 (Lua VM 명령어 1개 = 0.1 µs). 출력 쓰기는 명령어 단위의 정확한 시각
  (클럭 엣지)에 반영되므로, delay 없는 비트뱅잉 루프의 토글 속도는 CPU 속도로 결정됩니다. CPI = 0 이면 이상적 0-시간 실행.
  `delay()` 등은 클럭 엣지로 올림 정렬되며, 주기 제어에는 드리프트 없는 `every()` / `wait_until()` 을 권장합니다.
- **PWM**: 주기 = round(CLK/f) tick, High = round(duty × 주기) tick. 주파수/듀티 변경 시 카운터는 계속 진행(위상 유지).
- **필터/커플링**: 1차 RC 단의 직렬 연결을 상수 입력 구간에서 지수함수 합으로 정확히 계산(LPF 출력 = v_C, HPF 출력 = v_in − v_C).
  AC 커플링은 차단주파수 10 Hz 의 HPF 입니다. 필터 설정 변경 시 새 필터는 현재 입력의 DC 정상상태에서 시작합니다.
- **ADC**: 8bit(25 LSB/div, ±5.12 div), 입력 환산 잡음(Display ▸ Noise 로 끄기 가능). 트리거 회로는 잡음 없는 신호를 사용합니다.
- **획득**: 무장(Arm) 후 Pre-trigger 구간이 채워져야 트리거 허용, 레코드 완료 후 다음 틱에 재무장(데드타임).
  Auto 모드는 일정 시간(max(레코드 길이, 20 ms)) 동안 트리거가 없으면 강제 획득,
  Auto + 100 ms/div 이상에서는 Roll 모드(스크롤)로 동작합니다.
- **XY 획득**: 트리거 없이 연속 획득. 매 틱 `(t_prev, t_now]` 에 속하는 격자 시각 `t_k = k / fs` 에서 CH1, CH2 를 같은 시각 배열로
  샘플링(ADC 포함)해 링버퍼(용량 = max(Points, 0.1 s 분량), 최대 262 k)에 저장합니다. 한 틱의 샘플 수가 용량을 넘으면(MAX 속도 등)
  가장 오래된 구간을 생략하며, 잔상 표시에서는 그 공백을 잇지 않습니다. Stop 은 획득만 멈추고(재개 시 새 궤적),
  Pause 는 시뮬레이션 시간 자체가 멈추므로 잔상 감쇠도 함께 정지합니다.

## 네트워크 (HTTP / WebSocket)

스크립트가 로컬 서버 등 외부에서 데이터를 받아 출력에 쓸 수 있습니다 (예: parquet 의 프레임별 점 집합 → DAC → XY 산점도).
브라우저 페이지는 TCP/UDP 소켓을 직접 열 수 없으므로 HTTP fetch 와 WebSocket 을 제공하고, TCP/UDP 송신 프로그램은 서버의 중계 기능으로 연결합니다.

**시간 모델** — 시뮬레이션 시계는 네트워크 대기와 무관하게 계속 흐릅니다. 응답을 기다리는 동안 무엇을 출력할지는 스크립트가 정합니다.

- **비동기형**: `req = http_request(url)` 은 즉시 반환 → `req:ready()` 로 확인하며 그동안 하고 싶은 출력을 계속
  (예: 이전 프레임을 계속 그리기). WebSocket 은 `ws:poll()` / `ws:available()`.
- **대기형**: `http_get()`, `req:wait()`, `ws:recv()`, `ws_open()` 은 `delay()` 처럼 잠들어 기다립니다 (그동안 출력 레지스터는 마지막 값 유지).
  `timeout` 은 **시뮬레이션 시간**(초)입니다. HTTP 의 `net_timeout`(실제 시간, 기본 15 s)은 서버가 응답하지 않을 때의 안전장치입니다.
- 응답은 JS 이벤트 처리 후(다음 시뮬레이션 틱)에 보이며, 대기형 호출은 그 틱이 시작된 시각 직후 클럭 엣지에서 깨어납니다.
  따라서 결과가 보이는 시뮬레이션 시각은 실제 지연 × 속도 배율만큼 늦어집니다 (MAX 속도에서는 같은 지연이 더 긴 시뮬레이션 시간이 됨).
- 데이터는 **바이트 그대로** 전달됩니다 (텍스트/바이너리 무손실, 바이너리는 `string.unpack("<I2", s, pos)` 등으로 해석).
- 스크립트가 정지/종료되면 진행 중인 요청은 취소되고 열린 WebSocket 은 닫힙니다.
- 대기형 호출은 메인 스크립트에서만 가능합니다 (사용자 coroutine 안에서는 `ready()` / `poll()` 사용).

```lua
local body, status, headers = http_get("http://127.0.0.1:8000/api/info", { timeout = 2 })
local req = http_request("http://127.0.0.1:8000/api/frame/0")      -- 비동기
while not req:ready() do gpio_toggle(GPIO1); delay(1) end           -- 대기 중 출력은 스크립트가 결정
local frame, st = req:result()

local ws = assert(ws_open("ws://127.0.0.1:8000/ws"))
ws:send("frame 3")             local msg = ws:recv(0.5)            -- nil, "timeout" | nil, "closed"
local m = ws:poll()            -- 대기 없이 꺼내기 (없으면 nil)
```

### 데이터 서버 `tools/signal_server.py`

앱에 데이터를 보내는 별도의 서버입니다. 앱은 지금처럼 `index.html` 을 직접 열어서 사용하며, 서버 응답의 `Access-Control-Allow-Origin: *` 로 접속합니다.
표준 라이브러리만 사용합니다 (parquet 사용 시에만 `pip install pyarrow numpy`).

```sh
python tools/signal_server.py --demo                                   # 데모: 회전하는 점 구름 (250 프레임, 25 fps, 최대 3000 점)
python tools/signal_server.py --parquet points.parquet --fps 30        # 열 자동 인식 (frame/x/y 등), 또는
python tools/signal_server.py --parquet points.parquet --frame-col f --x-col px --y-col py --flip-y
python tools/signal_server.py --demo --udp-port 9001 --tcp-port 9002   # UDP/TCP → WebSocket /relay 중계
```

| 경로 | 내용 |
|---|---|
| `GET /api/info` | `frames=… fps=… max_points=… total_points=… dac_max=… source=…` (key=value 줄) |
| `GET /api/frame/<k>` | `x1,y1,x2,y2,…` DAC 코드(0..4095) 텍스트. `?fmt=bin` → little-endian uint16 |
| `GET /api/frames?start=k&count=n` | 한 줄에 한 프레임 (최대 1000) |
| `POST /api/echo` | 본문 그대로 반환 (연결 확인용) |
| `ws://…/ws` | 명령: `info`, `frame <k> [bin]`, `stream [start] [count] [fps] [bin]`(실시간 push, count 0 = 무한), `stop`, `ping` |
| `ws://…/relay` | `--udp-port`(데이터그램 1개 = 메시지 1개) / `--tcp-port`(줄 1개 = 메시지 1개) 수신 데이터를 그대로 전달. 브라우저가 보낸 메시지는 TCP 클라이언트와 마지막 UDP 송신자에게 전달 |

- parquet 레이아웃: **long**(한 행 = 점, frame 열로 묶음) 또는 **list**(한 행 = 프레임, x/y 가 리스트 열). NaN 점은 제외.
- 좌표 변환: 전체 데이터 범위 → 0..4095 (기본: 가로세로 비율 유지 + 5 % 여백, `--no-keep-aspect`, `--flip-y`, `--margin`).
- 측정(이 PC): 1080 만 점(5400 프레임, 99 MB) parquet 로딩 0.75 s, 프레임 응답 중앙값 약 1 ms.
  Lua 파싱(`gmatch`)은 3000 점 프레임당 약 6 ms(실제 시간)이므로 30 fps 1X 재생에 여유가 있습니다.

## 스크립트 API 요약

```lua
-- 핀: GPIO1 GPIO2 PWM1 PWM2 DAC1 DAC2,  상수: HIGH LOW VCC(3.3) VREF(3.3) DAC_MAX(4095)
gpio_write(GPIO1, HIGH)          gpio_toggle(GPIO2)          local v = gpio_read(GPIO1)
pwm_start(PWM1, 20000, 25)       pwm_set_duty(PWM1, 60)      local f, d, on = pwm_read(PWM1)
dac_write(DAC1, 2048)            dac_write_voltage(DAC2, 1.2) local code, volt = dac_read(DAC1)
analogWrite(PWM2, 128)           analogWrite(DAC1, 4095)     local t = pin_read(PWM1)  -- 레지스터 테이블

delay(1)  delay_us(10)  delay_ns(100)  sleep(0.5)  delay_clk(100)
wait_until(sim_time() + 0.01)    wait_until_clk(ticks() + 1000)
for n, t in every(0.001) do ... end            -- 드리프트 없는 1 ms 주기 루프
sim_time()  millis()  micros()  nanos()  ticks()  clk_freq()  cpi()

local f = io.open("log.csv", "w")  f:write("t,v\n")  f:close()
for line in io.lines("wave.csv") do ... end
fs.list()  fs.exists("a.txt")  fs.read("a.txt")  fs.write("a.txt", "...")  dofile("lib.lua")  require("mod")
print(...)  printf("%.3f V", v)

local req = http_request(url)  req:ready()  req:result()  req:wait(0.1)   http_get(url)  http_post(url, body)
local ws = ws_open(url)  ws:send(s)  ws:recv(0.1)  ws:poll()  ws:available()  ws:state()  ws:close()
```

전체 목록은 창 2 의 **API 도움말** 탭 또는 별도 문서 [`api.html`](api.html) (탭의 **새 탭에서 크게 보기** 링크)를 참고하세요.

### 예제 (창 2 ▸ 예제 불러오기 / `examples/*.lua`)
예제를 불러오면 권장 프로브/스코프 설정이 함께 적용됩니다.

| 예제 | 내용 |
|---|---|
| 00_quickstart | GPIO 1 kHz 토글 + PWM 2 kHz/25% |
| 01_gpio_registers | 반대 위상 토글, 출력 레지스터 읽기, 비트 연산/조건문 |
| 02_pwm_sweep | PWM 듀티 스윕, 주파수 전환 |
| 03_dac_waves | DAC 사인파/삼각파 (10 kHz 갱신) |
| 04_uart_bitbang | 9600 bps UART 비트뱅잉 (클럭 tick 정밀 타이밍, Falling 트리거) |
| 05_pwm_rc_dac | PWM + RC LPF → 아날로그 전압, Peak Detect 로 PWM 포락선 |
| 06_file_playback | CSV 파형 파일 읽기 → DAC 재생, 결과 로그 파일 쓰기 |
| 07_glitch | 1 µs 글리치 → Sample vs Peak Detect, Single 트리거 |
| 08_cpu_timing | 명령어 실행시간(CPI) 모델과 비트뱅잉 속도 |
| 09_xy_lissajous | **XY 모드**: DAC1/DAC2 사인파 리사주 도형 (1:1 원 → 1:2 → 3:2 → 3:4 → 45° 타원), Persistence |
| 10_xy_rc_phase | **XY 모드**: 사인파 vs RC LPF 통과 사인파 → 위상 지연 타원, Δφ / 진폭비를 이론값과 비교 |
| 11_net_http_frames | **네트워크(HTTP)**: 서버 프레임을 미리 요청(8 프레임)해 XY 산점도로 재생. 미도착 시 이전 프레임 유지. 서버 필요 |
| 12_net_ws_stream | **네트워크(WebSocket)**: 서버가 실시간 fps 로 push 하는 프레임 중 최신 것만 표시 (라이브 소스 / `/relay` 중계용). 서버 필요 |

예제 11, 12 는 CPI = 0 으로 설정됩니다. CPI ≥ 1 이면 파싱 시간 동안 빔이 한 점에 멈추고, X/Y 두 DAC 쓰기 사이의
명령어 시간 동안 (새 X, 이전 Y) 위치에 점이 찍히기 때문입니다. 서버가 없으면 1 초마다 재연결을 시도합니다.
GitHub Pages 같은 공개 웹 주소로 열면 예제 11, 12 는 목록에서 비활성화됩니다. `index.html` 을 직접 열거나 `localhost` 로 열면 그대로 사용할 수 있습니다.

## 파일 구조

다른 agent를 위한 파일별 역할, 의존 관계, 기능별 수정 위치 및 테스트 안내는 [`PROJECT_STRUCTURE.yaml`](PROJECT_STRUCTURE.yaml)을 참고하세요.

```
index.html            진입점
api.html              Lua API 문서 (앱 옆에 띄워 두는 별도 페이지)
css/style.css         스타일
lib/fengari-web.js    Lua 5.3 VM (MIT, lib/fengari-web.LICENSE.txt)
js/util.js            단위 포맷/파싱 등 공용 유틸
js/signal.js          신호 체인 해석 계산 (RC 단, PWM 주기 점프, 샘플링, Peak, 트리거 교차 탐색)
js/board.js           보드/핀/레지스터, PinFilter(필터 단), ScopeInput(커플링), 이벤트 라우터
js/vfs.js             가상 파일 시스템 + PC 폴더 연결
js/net.js             네트워크 계층 (HTTP fetch / WebSocket, 바이트 그대로 전달, 스크립트 정지 시 정리)
js/lua_prelude.js     Lua 프렐류드 (API 래퍼, io 라이브러리, require, http/ws 래퍼)
js/lua_runtime.js     스크립트 실행기 (코루틴, 명령어 시간 모델, API 바인딩)
js/scope.js           오실로스코프 획득 엔진 (트리거, 획득 모드, ADC, Roll, 측정)
js/sim.js             시뮬레이션 엔진 (Simulation Clock, 속도, Pause)
js/scope_view.js      오실로스코프 화면 렌더링/마우스 조작 (Y-T)
js/scope_view_xy.js   XY 모드 화면 (Line/Dot/Persistence, 축 눈금/0 V 기준선, Zoom/오버뷰, 표시 중단 안내)
js/ui_*.js, main.js   창/컨트롤/편집기/앱 구성
js/api_doc.js         Lua API 도움말 내용 (API 도움말 탭과 api.html 공용)
examples/*.lua        예제 스크립트
tools/signal_server.py  데이터 서버 (HTTP API + WebSocket + UDP/TCP 중계, parquet/데모 프레임)
tests/test.html       코어 테스트 (브라우저로 열면 결과 표시)
tests/run_tests.sh    헤드리스 Chrome 테스트 실행 (Git Bash)
tests/test_signal_server.py  서버 테스트 (HTTP/WebSocket/중계/parquet)
tests/net_e2e.html, run_net_e2e.py  실제 서버 ↔ 브라우저 Lua 종단 간 테스트
```

## 테스트

`tests/test.html` 을 브라우저로 열면 코어 테스트 결과가 표시됩니다(약 10초).
Git Bash 에서는 `sh tests/run_tests.sh` (특정 섹션: `sh tests/run_tests.sh 4,6`).

검증 항목: RC 체인 해석해 vs RK4 수치적분, PWM 주기 점프 vs 엣지 단위 적분, 트리거 교차 시각(해석해/무차별 대입 비교),
Peak Detect 글리치 보존, Lua 타이밍/파일 입출력/비트 연산/오류 줄 번호, 명령어 시간 모델과 클럭 정렬, 전체 시뮬레이터
(주파수·듀티 측정, LPF·AC 커플링), 성능(1 Mpts), Average 잡음 감소, Single, MAX 속도 예산, 모든 예제 실행,
XY 모드(섹션 11: 동일 시각 샘플 쌍, 필터/커플링 적용, 리사주 원·RC 위상, Probe 미연결/Disable/채널 OFF 시 중단·재개,
Run/Stop/Single, CSV, Y-T 복귀, 1 MSa/s 연속 획득 성능), 네트워크(섹션 12: 모의 fetch/WebSocket 으로 대기 중 시계 진행·출력 유지,
비동기 확인, 시뮬레이션 시간 timeout, 바이너리 무손실, 오류/종료 처리, 스크립트 정지 시 정리, 예제 11·12).

서버와 실제 네트워크:

```sh
python tests/test_signal_server.py -v      # 서버 단위 테스트 (pyarrow 가 있으면 parquet 포함)
python tests/run_net_e2e.py                # 데모 서버 + 헤드리스 Chrome: file:// 로 연 페이지의 HTTP·WebSocket·예제 11·12
```

## 참고 / 제약

- Lua 정수는 fengari 특성상 **32bit** 입니다 (MCU 레지스터 폭과 동일). 큰 tick 값은 자동으로 실수로 반환됩니다.
- `delay()` 계열은 메인 스크립트에서 호출해야 시뮬레이션 시간에 맞춰 일시정지됩니다. 사용자 코루틴 내부에서 호출하면
  일시정지 없이 보드 시간만 진행합니다.
- 파일은 텍스트 파일 기준입니다. 가상 파일 시스템은 브라우저 저장소(약 5 MB)에 보관됩니다.
  큰 데이터나 바이너리는 네트워크(HTTP / WebSocket)로 받으세요 (바이트 그대로 전달).
- 네트워크 응답은 다음 시뮬레이션 틱부터 보입니다. 한 틱(1X 에서 약 4 ms) 안에서는 새 응답이 도착하지 않습니다.
