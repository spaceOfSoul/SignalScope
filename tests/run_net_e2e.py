"""네트워크 종단 간 테스트: 데모 서버 + 헤드리스 Chrome(DevTools 프로토콜)으로 tests/net_e2e.html 실행

  python tests/run_net_e2e.py            (환경변수 CHROME 으로 Chrome 경로 변경 가능)

  실제 사용과 같이 file:// 로 연 페이지에서 CORS 를 거쳐 데이터 서버에 접속한다.
  실제 네트워크와 실제 시간이 필요하므로 --dump-dom(로드 직후 덤프) 대신 CDP 로 완료(title=DONE)까지 기다린다.
"""
import base64
import importlib.util
import json
import os
import pathlib
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("signal_server", os.path.join(ROOT, "tools", "signal_server.py"))
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)

CHROME = os.environ.get("CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class CDP:
    """DevTools 프로토콜용 최소 WebSocket 클라이언트"""

    def __init__(self, ws_url):
        host, path = ws_url[len("ws://"):].split("/", 1)
        h, p = host.split(":")
        self.s = socket.create_connection((h, int(p)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(("GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, key)).encode())
        self.f = self.s.makefile("rb")
        if b" 101 " not in self.f.readline():
            raise RuntimeError("CDP websocket handshake failed")
        while self.f.readline() not in (b"\r\n", b""):
            pass
        self.n = 0

    def _send(self, text):
        data, mask = text.encode(), os.urandom(4)
        n = len(data)
        hdr = bytearray([0x81])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        self.s.sendall(bytes(hdr) + mask + ss._unmask(data, mask))

    def _recv(self):
        buf = b""
        while True:
            b0, b1 = self.f.read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.f.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.f.read(8))[0]
            buf += self.f.read(n)
            if b0 & 0x80:
                return json.loads(buf.decode())

    def call(self, method, **params):
        self.n += 1
        self._send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = self._recv()
            if m.get("id") == self.n:
                return m.get("result", {})

    def eval(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True)
        return r.get("result", {}).get("value")

    def close(self):
        self.f.close()
        self.s.close()


def run_page(cdp, url, timeout=60):
    cdp.call("Page.navigate", url=url)
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.5)
        try:
            if cdp.eval("document.title") == "DONE":
                break
        except (OSError, ValueError):
            pass
    return cdp.eval("document.getElementById('out') ? document.getElementById('out').textContent : 'NO OUTPUT'") or "NO OUTPUT"


def main():
    for st in (sys.stdout, sys.stderr):           # Windows 콘솔(cp949 등)에서 출력 불가 문자로 중단되지 않게
        try:
            st.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    port, dport = free_port(), free_port()
    server = ss.build_server(ss.DemoSource(), port=port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    prof = tempfile.mkdtemp(prefix="sscope_cdp_")
    chrome = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files",
                               "--remote-debugging-port=%d" % dport, "--user-data-dir=" + prof, "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0
    try:
        ws_url = None
        for _ in range(100):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % dport, timeout=1) as r:
                    pages = [t for t in json.load(r) if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except OSError:
                pass
            time.sleep(0.2)
        if not ws_url:
            print("Chrome DevTools 에 연결하지 못했습니다")
            return 2
        cdp = CDP(ws_url)
        url = pathlib.Path(ROOT, "tests", "net_e2e.html").as_uri() + "?base=http://127.0.0.1:%d" % port
        print("== " + url)
        text = run_page(cdp, url)
        print(text)
        first = text.splitlines()[0] if text else ""
        if not first.startswith("RESULT") or "fail=0" not in first:
            fails += 1
        cdp.close()
    finally:
        chrome.terminate()
        try:
            chrome.wait(10)
        except subprocess.TimeoutExpired:
            chrome.kill()
        server.shutdown()
        server.server_close()
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
