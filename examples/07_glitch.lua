-- 100 ms 마다 1 µs 폭의 펄스를 GPIO1 로 출력
-- 20 ms/div (50 kSa/s @ 10k pts) 에서 Sample 모드는 펄스를 대부분 놓친다.
--  → Acquire 를 Peak Detect 로 바꾸면 모든 펄스가 보인다.
--  → Time/div 를 줄이고 Single 로 펄스 1회 포착 / Zoom 으로 확대해 보자.
while true do
  delay(100)
  gpio_write(GPIO1, HIGH)
  delay_us(1)
  gpio_write(GPIO1, LOW)
end
