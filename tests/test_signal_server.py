"""tools/signal_server.py 테스트 (표준 라이브러리 unittest)

  python tests/test_signal_server.py -v
  (parquet 테스트는 pyarrow, numpy 가 설치된 경우에만 실행)
"""
import base64
import importlib.util
import os
import socket
import struct
import tempfile
import threading
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("signal_server", os.path.join(ROOT, "tools", "signal_server.py"))
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)

try:
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq
    HAVE_ARROW = True
except ImportError:
    HAVE_ARROW = False


def free_port(kind=socket.SOCK_STREAM):
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class WSClient:
    """테스트용 최소 WebSocket 클라이언트 (클라이언트 프레임은 마스킹)"""

    def __init__(self, port, path):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, port, key)).encode())
        self.f = self.s.makefile("rb")
        status = self.f.readline()
        assert b" 101 " in status, status
        while self.f.readline() not in (b"\r\n", b""):
            pass

    def send(self, data, op=None):
        if isinstance(data, str):
            data, op = data.encode(), op or 1
        op = op or 2
        mask = os.urandom(4)
        n = len(data)
        hdr = bytearray([0x80 | op])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        self.s.sendall(bytes(hdr) + mask + ss._unmask(data, mask))

    def recv(self):
        b0, b1 = self.f.read(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self.f.read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self.f.read(8))[0]
        return b0 & 0x0F, self.f.read(n)

    def close(self):
        try:
            self.send(struct.pack(">H", 1000), op=8)
        except OSError:
            pass
        self.f.close()
        self.s.close()


def get(port, path, method="GET", body=None, headers=None):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, r.read()          # HTTPMessage: 헤더 이름 대소문자 무시
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers, e.read()


class ServerCase(unittest.TestCase):
    src = None
    udp = tcp = None

    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        if cls.udp is True:
            cls.udp = free_port(socket.SOCK_DGRAM)
        if cls.tcp is True:
            cls.tcp = free_port()
        cls.server = ss.build_server(cls.src or ss.DemoSource(frames=20, fps=50, max_points=300),
                                     port=cls.port, udp_port=cls.udp, tcp_port=cls.tcp)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()


class TestHTTP(ServerCase):
    def test_info(self):
        st, h, body = get(self.port, "/api/info")
        self.assertEqual(st, 200)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "*")
        info = dict(line.split("=", 1) for line in body.decode().strip().splitlines())
        self.assertEqual(info["frames"], "20")
        self.assertEqual(info["fps"], "50")
        self.assertEqual(info["source"], "demo")

    def test_frame_text_and_bin(self):
        st, _, txt = get(self.port, "/api/frame/3")
        self.assertEqual(st, 200)
        vals = [int(v) for v in txt.decode().strip().split(",")]
        self.assertEqual(len(vals) % 2, 0)
        self.assertTrue(100 <= len(vals) // 2 <= 300)
        self.assertTrue(all(0 <= v <= 4095 for v in vals))
        st, h, b = get(self.port, "/api/frame/3?fmt=bin")
        self.assertEqual(h.get("Content-Type"), "application/octet-stream")
        self.assertEqual(list(struct.unpack("<%dH" % (len(b) // 2), b)), vals)

    def test_frames_batch_and_errors(self):
        st, _, body = get(self.port, "/api/frames?start=18&count=5")
        self.assertEqual(st, 200)
        self.assertEqual(len(body.decode().strip().splitlines()), 2)   # 18, 19 만 존재
        self.assertEqual(get(self.port, "/api/frame/20")[0], 404)
        self.assertEqual(get(self.port, "/api/frame/x")[0], 400)
        self.assertEqual(get(self.port, "/api/nope")[0], 404)

    def test_options_and_echo(self):
        st, h, _ = get(self.port, "/api/frame/0", method="OPTIONS", headers={"Access-Control-Request-Headers": "x-a"})
        self.assertEqual(st, 204)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("x-a", h.get("Access-Control-Allow-Headers", ""))
        payload = bytes(range(256))
        st, _, body = get(self.port, "/api/echo", method="POST", body=payload, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual((st, body), (200, payload))

    def test_port_in_use_fails(self):
        # Windows 에서도 같은 포트에 두 번째 서버가 조용히 bind 되면 안 됨
        with self.assertRaises(OSError):
            ss.build_server(ss.DemoSource(frames=2), port=self.port)

    def test_static_app(self):
        st, h, body = get(self.port, "/")
        self.assertEqual(st, 200)
        self.assertIn(b"js/net.js", body)
        st, h, _ = get(self.port, "/js/net.js")
        self.assertEqual(st, 200)
        self.assertIn("javascript", h.get("Content-Type", ""))


class TestWebSocket(ServerCase):
    def test_commands(self):
        ws = WSClient(self.port, "/ws")
        try:
            ws.send("info")
            op, m = ws.recv()
            self.assertEqual(op, 1)
            self.assertIn(b"frames=20", m)
            ws.send("frame 4")
            op, m = ws.recv()
            self.assertEqual((op, m), (1, get(self.port, "/api/frame/4")[2]))
            ws.send("frame 4 bin")
            op, m = ws.recv()
            self.assertEqual((op, m), (2, get(self.port, "/api/frame/4?fmt=bin")[2]))
            ws.send("ping")
            self.assertEqual(ws.recv(), (1, b"pong"))
            ws.send("bogus")
            self.assertTrue(ws.recv()[1].startswith(b"error unknown command"))
            ws.send("frame")
            self.assertTrue(ws.recv()[1].startswith(b"error frame"))
            ws.send(bytes([0, 128, 255]))                       # binary echo
            self.assertEqual(ws.recv(), (2, bytes([0, 128, 255])))
            big = os.urandom(200000)                            # 64-bit 길이 프레임
            ws.send(big)
            self.assertEqual(ws.recv(), (2, big))
        finally:
            ws.close()

    def test_stream_rate(self):
        ws = WSClient(self.port, "/ws")
        try:
            t0 = time.perf_counter()
            ws.send("stream 18 6 100")
            frames = [ws.recv()[1] for _ in range(6)]
            dt = time.perf_counter() - t0
            expect = [get(self.port, "/api/frame/%d" % (k % 20))[2] for k in range(18, 24)]
            self.assertEqual(frames, expect)                     # 18, 19, 0, 1, 2, 3 (순환)
            self.assertTrue(0.04 <= dt <= 1.0, dt)              # 100 fps × 6 ≈ 0.05 s
        finally:
            ws.close()


class TestRelay(ServerCase):
    udp = True
    tcp = True

    def test_udp_tcp_relay(self):
        ws = WSClient(self.port, "/relay")
        try:
            time.sleep(0.05)
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            u.sendto(bytes([0, 255, 16]), ("127.0.0.1", self.udp))
            self.assertEqual(ws.recv(), (2, bytes([0, 255, 16])))       # 바이너리 데이터그램 → binary 메시지
            u.sendto(b"hello udp", ("127.0.0.1", self.udp))
            self.assertEqual(ws.recv(), (1, b"hello udp"))               # UTF-8 → text 메시지
            t = socket.create_connection(("127.0.0.1", self.tcp), timeout=5)
            t.sendall(b"line one\nline two\r\n")
            self.assertEqual(ws.recv(), (1, b"line one"))
            self.assertEqual(ws.recv(), (1, b"line two"))
            ws.send("to sender")                                         # 브라우저 → TCP / 마지막 UDP 송신자
            t.settimeout(5)
            with t.makefile("rb") as tf:
                self.assertEqual(tf.readline(), b"to sender\n")
            u.settimeout(5)
            self.assertEqual(u.recvfrom(100)[0], b"to sender")
            t.close(); u.close()
        finally:
            ws.close()


@unittest.skipUnless(HAVE_ARROW, "pyarrow/numpy 미설치")
class TestParquet(unittest.TestCase):
    def test_long_layout(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "long.parquet")
            # 프레임 순서를 섞고, 프레임 2 에는 NaN 점 포함
            frame = [2, 0, 1, 0, 2, 2, 1]
            x = [100.0, 0.0, 50.0, 200.0, float("nan"), 120.0, 60.0]
            y = [10.0, 0.0, 5.0, 100.0, 1.0, 20.0, 6.0]
            pq.write_table(pa.table({"frame": frame, "x": x, "y": y}), p)
            src = ss.ParquetSource(p, fps=30)
            self.assertEqual((src.frames, src.total_points, src.max_points), (3, 6, 2))
            f0 = src.frame_codes(0).tolist()
            # 범위 x 0..200, y 0..100, 비율 유지: span = 4095·0.9, 배율 = span/200
            s = 4095 * 0.9 / 200
            mid = 4095 / 2
            self.assertEqual(f0, [round(mid + (0 - 100) * s), round(mid + (0 - 50) * s),
                                  round(mid + (200 - 100) * s), round(mid + (100 - 50) * s)])
            self.assertEqual(len(src.frame_codes(2)), 4)                  # NaN 점 제외
            self.assertIn("layout=long", src.mapping)

    def test_list_layout_and_server(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "list.parquet")
            pq.write_table(pa.table({"frame_idx": [1, 0], "px": [[0.0, 1.0, 2.0], [5.0]], "py": [[0.0, 1.0, 2.0], [5.0]]}), p)
            src = ss.ParquetSource(p, flip_y=True, keep_aspect=False)
            self.assertEqual((src.frames, src.max_points), (2, 3))
            self.assertEqual(len(src.frame_codes(0)), 2)                  # frame_idx 0 → [5.0]
            c1 = src.frame_codes(1).tolist()
            self.assertTrue(c1[1] > c1[3] > c1[5])                         # flip-y: y 증가 → 코드 감소
            port = free_port()
            srv = ss.build_server(src, port=port)
            th = threading.Thread(target=srv.serve_forever, daemon=True)
            th.start()
            try:
                self.assertIn(b"frames=2", get(port, "/api/info")[2])
                self.assertEqual(get(port, "/api/frame/1")[2].decode().strip(), ",".join(map(str, c1)))
            finally:
                srv.shutdown(); srv.server_close()

    def test_missing_column_message(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "bad.parquet")
            pq.write_table(pa.table({"a": [1], "b": [2]}), p)
            with self.assertRaises(SystemExit) as cm:
                ss.ParquetSource(p)
            self.assertIn("사용 가능한 열: a, b", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
