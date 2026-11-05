#!/usr/bin/env python3
"""SignalScope 데이터 서버 — 브라우저 Lua 스크립트(http_get / ws_open)에 프레임 데이터를 제공한다.

실행 (저장소 루트에서):
  python tools/signal_server.py --demo
  python tools/signal_server.py --parquet points.parquet [--frame-col frame --x-col x --y-col y] [--fps 30]
  python tools/signal_server.py --demo --udp-port 9001 --tcp-port 9002      # UDP/TCP → WebSocket 중계

  앱은 index.html 을 브라우저로 직접 열어서 사용한다. 이 서버는 데이터만 보낸다.
  (file:// 로 연 앱에서 접근할 수 있도록 응답에는 Access-Control-Allow-Origin: * 를 붙인다.)

HTTP
  GET /api/info                      key=value 줄: frames, fps, max_points, total_points, dac_max, source
  GET /api/frame/<k>                 "x1,y1,x2,y2,...\\n"  (DAC 코드 0..dac_max 정수)
  GET /api/frame/<k>?fmt=bin         little-endian uint16 (x1 y1 x2 y2 ...)
  GET /api/frames?start=k&count=n    한 줄에 한 프레임 (텍스트, 최대 1000 프레임)
WebSocket
  /ws     텍스트 명령:  info | frame <k> [bin] | stream [start] [count] [fps] [bin] | stop | ping
          stream: 서버가 실제 시간 기준 fps 로 프레임을 push (count 0 = 끝없이 반복)
  /relay  --udp-port / --tcp-port 로 받은 데이터를 연결된 모든 클라이언트에 메시지 그대로 전달
          (UDP: 데이터그램 1개 = 메시지 1개, TCP: 줄 1개 = 메시지 1개)
          반대로 브라우저가 보낸 메시지는 TCP 클라이언트(줄 단위)와 마지막 UDP 송신자에게 전달

의존성: 표준 라이브러리만 사용. --parquet 사용 시에만 pyarrow, numpy 필요 (pip install pyarrow numpy)
"""
import argparse
import base64
import hashlib
import math
import os
import socket
import socketserver
import struct
import sys
import threading
import time
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


# ============================================================================
# 프레임 소스
# ============================================================================
class FrameSource:
    """frames, fps, dac_max, source 속성과 frame_codes(k) → [x1, y1, x2, y2, ...] (DAC 코드) 를 제공"""
    frames = 0
    fps = 30.0
    dac_max = 4095
    source = ""
    max_points = 0
    total_points = 0

    def frame_codes(self, k):
        raise NotImplementedError

    def info_text(self):
        return ("frames=%d\nfps=%g\nmax_points=%d\ntotal_points=%d\ndac_max=%d\nsource=%s\n"
                % (self.frames, self.fps, self.max_points, self.total_points, self.dac_max, self.source))


class DemoSource(FrameSource):
    """의존성 없는 데모: 회전하는 3차원 점 구름(구 표면 나선)을 정사영. 프레임마다 점 수가 1000~3000 으로 변한다."""

    def __init__(self, frames=250, fps=25.0, max_points=3000, dac_max=4095):
        self.frames, self.fps, self.dac_max = frames, fps, dac_max
        self.max_points = max_points
        self.source = "demo"
        self._cache = {}
        self.total_points = sum(self._npts(k) for k in range(frames))

    def _npts(self, k):
        lo = self.max_points // 3
        return int(lo + (self.max_points - lo) * (0.5 + 0.5 * math.cos(2 * math.pi * k / self.frames)))

    def frame_codes(self, k):
        k %= self.frames
        c = self._cache.get(k)
        if c is not None:
            return c
        n = self._npts(k)
        a = 2 * math.pi * k / self.frames          # Y 축 회전
        tilt = 0.45 + 0.25 * math.sin(4 * math.pi * k / self.frames)
        ca, sa, ct, st = math.cos(a), math.sin(a), math.cos(tilt), math.sin(tilt)
        golden = math.pi * (3 - math.sqrt(5))
        mid, amp = self.dac_max / 2, self.dac_max * 0.45
        out = []
        for i in range(n):
            z = 1 - 2 * (i + 0.5) / n               # 피보나치 구
            r = math.sqrt(1 - z * z)
            th = golden * i
            x, y = r * math.cos(th), r * math.sin(th)
            x, z = x * ca + z * sa, -x * sa + z * ca  # 회전
            y, z = y * ct - z * st, y * st + z * ct
            out.append(int(round(mid + amp * x)))
            out.append(int(round(mid + amp * y)))
        self._cache[k] = out
        return out


class ParquetSource(FrameSource):
    """parquet 파일의 점 집합을 프레임별로 제공.

    지원 레이아웃
      long : 한 행 = 점 1개.  frame 열 + x 열 + y 열 (frame 값으로 묶음, frame 값 오름차순)
      list : 한 행 = 프레임 1개. x, y 열이 리스트(list<float>) (행 순서 또는 frame 열 오름차순)
    좌표는 전체 데이터의 최소/최대로 0..dac_max 에 맞춘다 (기본: 가로세로 비율 유지, 가장자리 여백 margin).
    """
    FRAME_NAMES = ("frame", "frame_idx", "frame_index", "frame_id", "frame_no", "frame_num", "f", "t", "time")
    X_NAMES = ("x", "px", "u", "col")
    Y_NAMES = ("y", "py", "v", "row")

    def __init__(self, path, frame_col=None, x_col=None, y_col=None, fps=30.0, dac_max=4095,
                 keep_aspect=True, flip_y=False, margin=0.05):
        try:
            import numpy as np
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError as e:
            raise SystemExit("--parquet 에는 pyarrow 와 numpy 가 필요합니다:  pip install pyarrow numpy  (%s)" % e)
        self.np = np
        self.fps, self.dac_max = float(fps), int(dac_max)
        self.source = os.path.basename(path)
        table = pq.read_table(path)
        names = table.column_names
        lower = {n.lower(): n for n in names}

        def pick(given, cands, what, required=True):
            if given:
                if given not in names:
                    raise SystemExit("열 '%s' 이(가) 없습니다. 사용 가능한 열: %s" % (given, ", ".join(names)))
                return given
            for c in cands:
                if c in lower:
                    return lower[c]
            if required:
                raise SystemExit("%s 열을 찾지 못했습니다. --%s-col 로 지정하세요. 사용 가능한 열: %s"
                                 % (what, what, ", ".join(names)))
            return None

        xc, yc = pick(x_col, self.X_NAMES, "x"), pick(y_col, self.Y_NAMES, "y")
        is_list = pa.types.is_list(table.schema.field(xc).type) or pa.types.is_large_list(table.schema.field(xc).type)
        fc = pick(frame_col, self.FRAME_NAMES, "frame", required=not is_list)

        if is_list:
            if fc:
                table = table.sort_by(fc)
            xs = table.column(xc).combine_chunks()
            ys = table.column(yc).combine_chunks()
            offsets = np.asarray(xs.offsets, dtype=np.int64)
            if not np.array_equal(offsets, np.asarray(ys.offsets, dtype=np.int64)):
                raise SystemExit("x 와 y 리스트의 길이가 프레임마다 같아야 합니다")
            x = np.asarray(xs.values.to_numpy(zero_copy_only=False), dtype=np.float64)
            y = np.asarray(ys.values.to_numpy(zero_copy_only=False), dtype=np.float64)
            offsets = offsets - offsets[0]
            layout = "list"
        else:
            f = table.column(fc).to_numpy()
            x = np.asarray(table.column(xc).to_numpy(), dtype=np.float64)
            y = np.asarray(table.column(yc).to_numpy(), dtype=np.float64)
            order = np.argsort(f, kind="stable")
            f, x, y = f[order], x[order], y[order]
            _, starts = np.unique(f, return_index=True)
            offsets = np.append(starts, len(f)).astype(np.int64)
            layout = "long"

        # NaN/inf 점 제거 (프레임 경계 유지)
        good = np.isfinite(x) & np.isfinite(y)
        if not good.all():
            cum = np.concatenate(([0], np.cumsum(good)))
            offsets = cum[offsets]
            x, y = x[good], y[good]
        if flip_y:
            y = -y
        if len(x) == 0:
            raise SystemExit("유효한 점이 없습니다")

        # 스케일: 전체 범위 → 0..dac_max
        x0, x1, y0, y1 = float(x.min()), float(x.max()), float(y.min()), float(y.max())
        span = self.dac_max * (1 - 2 * margin)
        rx, ry = max(x1 - x0, 1e-12), max(y1 - y0, 1e-12)
        if keep_aspect:
            sx = sy = span / max(rx, ry)
        else:
            sx, sy = span / rx, span / ry
        mid = self.dac_max / 2
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        codes = np.empty(2 * len(x), dtype=np.uint16)
        codes[0::2] = np.clip(np.rint(mid + (x - cx) * sx), 0, self.dac_max)
        codes[1::2] = np.clip(np.rint(mid + (y - cy) * sy), 0, self.dac_max)
        self.codes, self.offsets = codes, offsets
        counts = np.diff(offsets)
        self.frames = len(counts)
        self.max_points = int(counts.max()) if self.frames else 0
        self.total_points = int(counts.sum())
        self.layout = layout
        oy0, oy1 = (-y1, -y0) if flip_y else (y0, y1)          # 표시는 원래 좌표 기준
        self.mapping = ("layout=%s, columns frame=%s x=%s y=%s, x[%g..%g] y[%g..%g] -> 0..%d%s%s"
                        % (layout, fc, xc, yc, x0, x1, oy0, oy1, self.dac_max,
                           ", keep-aspect" if keep_aspect else "", ", flip-y" if flip_y else ""))

    def frame_codes(self, k):
        k %= self.frames
        a, b = int(self.offsets[k]), int(self.offsets[k + 1])
        return self.codes[2 * a:2 * b]


class FrameCache:
    """프레임 → 인코딩된 bytes (LRU)"""

    def __init__(self, src, size=512):
        self.src, self.size = src, size
        self.lock = threading.Lock()
        self.text, self.bin = OrderedDict(), OrderedDict()

    def _get(self, store, k, enc):
        k %= self.src.frames
        with self.lock:
            v = store.get(k)
            if v is not None:
                store.move_to_end(k)
                return v
        v = enc(self.src.frame_codes(k))
        with self.lock:
            store[k] = v
            while len(store) > self.size:
                store.popitem(last=False)
        return v

    @staticmethod
    def _ints(c):
        return c.tolist() if hasattr(c, "tolist") else list(c)

    def text_frame(self, k):
        return self._get(self.text, k, lambda c: (",".join(map(str, self._ints(c))) + "\n").encode("ascii"))

    def bin_frame(self, k):
        def enc(c):
            if hasattr(c, "astype"):
                return c.astype("<u2").tobytes()
            return struct.pack("<%dH" % len(c), *c)
        return self._get(self.bin, k, enc)


# ============================================================================
# WebSocket (RFC 6455, 서버 측 최소 구현)
# ============================================================================
class WSClosed(Exception):
    pass


def _unmask(data, mask):
    n = len(data)
    if n == 0:
        return b""
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "little") ^ int.from_bytes(m, "little")).to_bytes(n, "little")


class WSConn:
    def __init__(self, sock, rfile):
        self.sock, self.rfile = sock, rfile
        self.lock = threading.Lock()
        self.closed = False

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                raise WSClosed()
            buf += chunk
        return buf

    def _send_frame(self, op, payload):
        n = len(payload)
        hdr = bytearray([0x80 | op])
        if n < 126:
            hdr.append(n)
        elif n < 65536:
            hdr.append(126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(127)
            hdr += struct.pack(">Q", n)
        with self.lock:
            if self.closed:
                raise WSClosed()
            try:
                self.sock.sendall(bytes(hdr) + payload)
            except OSError:
                self.closed = True
                raise WSClosed()

    def send(self, data, binary=None):
        """str → text 프레임. bytes → binary 프레임 (binary=False 면 text 프레임으로 보냄: 내용이 UTF-8 이어야 함)"""
        if isinstance(data, str):
            self._send_frame(0x1, data.encode("utf-8"))
        else:
            self._send_frame(0x2 if binary is not False else 0x1, bytes(data))

    def send_auto(self, data):
        try:
            data.decode("utf-8")
            self._send_frame(0x1, data)
        except UnicodeDecodeError:
            self._send_frame(0x2, data)

    def recv(self):
        """완성된 메시지 (opcode, bytes) 반환. 연결 종료 시 WSClosed"""
        msg_op, buf = None, bytearray()
        while True:
            b0, b1 = self._read(2)
            fin, op = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = _unmask(payload, mask)
            if op == 0x8:                       # close
                try:
                    self._send_frame(0x8, payload[:2])
                except WSClosed:
                    pass
                self.closed = True
                raise WSClosed()
            if op == 0x9:                       # ping → pong
                self._send_frame(0xA, payload)
                continue
            if op == 0xA:                       # pong
                continue
            if op in (0x1, 0x2):
                msg_op, buf = op, bytearray(payload)
            elif op == 0x0 and msg_op is not None:
                buf += payload
            if fin and msg_op is not None:
                return msg_op, bytes(buf)

    def close(self):
        try:
            self._send_frame(0x8, struct.pack(">H", 1000))
        except WSClosed:
            pass
        self.closed = True


class Relay:
    """UDP/TCP 로 받은 데이터를 /relay WebSocket 클라이언트에 전달 (양방향)"""

    def __init__(self, host, udp_port=None, tcp_port=None):
        self.clients, self.tcp_clients = set(), set()
        self.lock = threading.Lock()
        self.udp_sock, self.udp_peer = None, None
        self.counts = {"udp": 0, "tcp": 0, "ws": 0}
        if udp_port:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.bind((host, udp_port))
            self.udp_sock = s
            threading.Thread(target=self._udp_loop, daemon=True).start()
        if tcp_port:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            if os.name != "nt":                   # Windows 의 SO_REUSEADDR 는 같은 포트 중복 bind 를 허용하므로 사용하지 않음
                srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind((host, tcp_port))
            srv.listen(8)
            self.tcp_srv = srv
            threading.Thread(target=self._tcp_accept, daemon=True).start()

    def broadcast(self, data):
        with self.lock:
            targets = list(self.clients)
        for ws in targets:
            try:
                ws.send_auto(data)
            except WSClosed:
                with self.lock:
                    self.clients.discard(ws)

    def _udp_loop(self):
        while True:
            try:
                data, addr = self.udp_sock.recvfrom(65535)
            except OSError:
                return
            self.udp_peer = addr
            self.counts["udp"] += 1
            self.broadcast(data)

    def _tcp_accept(self):
        while True:
            try:
                conn, _ = self.tcp_srv.accept()
            except OSError:
                return
            threading.Thread(target=self._tcp_client, args=(conn,), daemon=True).start()

    def _tcp_client(self, conn):
        with self.lock:
            self.tcp_clients.add(conn)
        try:
            f = conn.makefile("rb")
            for line in f:
                self.counts["tcp"] += 1
                self.broadcast(line.rstrip(b"\r\n"))
        except OSError:
            pass
        finally:
            with self.lock:
                self.tcp_clients.discard(conn)
            conn.close()

    def from_browser(self, data):
        """브라우저 → TCP 클라이언트(줄) / 마지막 UDP 송신자"""
        self.counts["ws"] += 1
        with self.lock:
            tcps = list(self.tcp_clients)
        for c in tcps:
            try:
                c.sendall(data + b"\n")
            except OSError:
                pass
        if self.udp_sock and self.udp_peer:
            try:
                self.udp_sock.sendto(data, self.udp_peer)
            except OSError:
                pass


# ============================================================================
# HTTP 핸들러
# ============================================================================
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SignalScopeServer/1.0"
    # 서버 생성 시 설정
    src = None
    cache = None
    relay = None
    verbose = False

    def log_message(self, fmt, *args):
        if self.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers", "*"))
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _reply(self, status, body, ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if self.headers.get("Upgrade", "").lower() == "websocket":
            if u.path in ("/ws", "/relay"):
                return self._websocket(u.path)
            return self._reply(HTTPStatus.NOT_FOUND, "unknown websocket path (use /ws or /relay)\n")
        if u.path.startswith("/api/"):
            try:
                return self._api(u)
            except (ValueError, IndexError) as e:
                return self._reply(HTTPStatus.BAD_REQUEST, "bad request: %s\n" % e)
        return self._reply(HTTPStatus.NOT_FOUND, "not found\n")

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if u.path == "/api/echo":
            return self._reply(HTTPStatus.OK, body, self.headers.get("Content-Type", "application/octet-stream"))
        if u.path == "/api/relay" and self.relay:
            self.relay.from_browser(body)
            return self._reply(HTTPStatus.OK, "ok\n")
        return self._reply(HTTPStatus.NOT_FOUND, "not found\n")

    def _api(self, u):
        src, q = self.src, parse_qs(u.query)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["api", "info"]:
            return self._reply(HTTPStatus.OK, src.info_text())
        if len(parts) == 3 and parts[:2] == ["api", "frame"]:
            k = int(parts[2])
            if not 0 <= k < src.frames:
                return self._reply(HTTPStatus.NOT_FOUND, "frame %d out of range (0..%d)\n" % (k, src.frames - 1))
            if q.get("fmt", ["text"])[0] == "bin":
                return self._reply(HTTPStatus.OK, self.cache.bin_frame(k), "application/octet-stream")
            return self._reply(HTTPStatus.OK, self.cache.text_frame(k))
        if parts == ["api", "frames"]:
            start = int(q.get("start", ["0"])[0])
            count = max(0, min(1000, int(q.get("count", ["1"])[0])))
            ks = [k for k in range(start, start + count) if 0 <= k < src.frames]
            return self._reply(HTTPStatus.OK, b"".join(self.cache.text_frame(k) for k in ks))
        return self._reply(HTTPStatus.NOT_FOUND, "unknown api: %s\n" % u.path)

    # ---------------- WebSocket ----------------
    def _websocket(self, path):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._reply(HTTPStatus.BAD_REQUEST, "missing Sec-WebSocket-Key\n")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        ws = WSConn(self.connection, self.rfile)
        try:
            if path == "/relay":
                self._relay_session(ws)
            else:
                self._frame_session(ws)
        except (WSClosed, OSError):
            pass
        finally:
            ws.closed = True

    def _relay_session(self, ws):
        if not self.relay:
            ws.send("error relay disabled (run with --udp-port and/or --tcp-port)")
            ws.close()
            return
        with self.relay.lock:
            self.relay.clients.add(ws)
        try:
            while True:
                _, data = ws.recv()
                self.relay.from_browser(data)
        finally:
            with self.relay.lock:
                self.relay.clients.discard(ws)

    def _frame_session(self, ws):
        src, cache = self.src, self.cache
        stream = {"stop": None}

        def stop_stream():
            if stream["stop"]:
                stream["stop"].set()
                stream["stop"] = None

        def send_frame(k, binary):
            if binary:
                ws.send(cache.bin_frame(k), binary=True)
            else:
                ws.send(cache.text_frame(k), binary=False)

        def streamer(stop, start, count, fps, binary):
            t0, i = time.perf_counter(), 0
            try:
                while not stop.is_set() and (count == 0 or i < count):
                    send_frame((start + i) % src.frames, binary)
                    i += 1
                    delay = t0 + i / fps - time.perf_counter()
                    if delay > 0:
                        stop.wait(delay)
                    elif delay < -1.0:                # 1 초 이상 밀리면 기준 시각 재설정 (몰아서 보내지 않음)
                        t0 = time.perf_counter() - i / fps
            except WSClosed:
                pass

        try:
            while True:
                op, data = ws.recv()
                if op != 0x1:
                    ws.send(data, binary=True)        # binary → echo
                    continue
                words = data.decode("utf-8", "replace").split()
                if not words:
                    continue
                cmd, args = words[0].lower(), words[1:]
                binary = "bin" in args
                nums = [a for a in args if a != "bin"]
                try:
                    if cmd == "info":
                        ws.send(src.info_text())
                    elif cmd == "frame":
                        send_frame(int(nums[0]) % src.frames, binary)
                    elif cmd == "stream":
                        stop_stream()
                        start = int(nums[0]) if len(nums) > 0 else 0
                        count = int(nums[1]) if len(nums) > 1 else 0
                        fps = float(nums[2]) if len(nums) > 2 else src.fps
                        if fps <= 0:
                            raise ValueError("fps must be > 0")
                        stop = threading.Event()
                        stream["stop"] = stop
                        threading.Thread(target=streamer, args=(stop, start, count, fps, binary), daemon=True).start()
                    elif cmd == "stop":
                        stop_stream()
                    elif cmd == "ping":
                        ws.send("pong")
                    else:
                        ws.send("error unknown command: " + cmd)
                except (ValueError, IndexError) as e:
                    ws.send("error %s: %s" % (cmd, e or "missing argument"))
        finally:
            stop_stream()


# ============================================================================
class Server(ThreadingHTTPServer):
    # Windows 에서 SO_REUSEADDR 는 이미 사용 중인 포트에 또 bind 하는 것을 허용한다 → 두 서버가 같은 포트를 나눠 가지는 문제 방지
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        # 브라우저가 keep-alive 연결을 끊는 것은 정상 상황 → traceback 출력 생략
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def build_server(src, host="127.0.0.1", port=8000, udp_port=None, tcp_port=None, verbose=False):
    server = Server((host, port), None)          # 포트 확보 먼저 (사용 중이면 여기서 OSError)
    relay = Relay(host, udp_port, tcp_port) if (udp_port or tcp_port) else None
    attrs = {"src": src, "cache": FrameCache(src), "relay": relay, "verbose": verbose}
    server.RequestHandlerClass = type("BoundHandler", (Handler,), attrs)
    server.daemon_threads = True
    server.relay = relay
    return server


def main(argv=None):
    ap = argparse.ArgumentParser(description="SignalScope 데이터 서버 (HTTP + WebSocket + UDP/TCP 중계)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--demo", action="store_true", help="데모 프레임 (회전하는 점 구름, 의존성 없음) — 기본값")
    g.add_argument("--parquet", metavar="FILE", help="parquet 파일 (pyarrow, numpy 필요)")
    ap.add_argument("--frame-col", help="프레임 번호 열 (long 레이아웃)")
    ap.add_argument("--x-col", help="x 좌표 열")
    ap.add_argument("--y-col", help="y 좌표 열")
    ap.add_argument("--fps", type=float, default=None, help="프레임 속도 (parquet 기본 30, 데모 기본 25)")
    ap.add_argument("--flip-y", action="store_true", help="y 축 반전 (영상 좌표처럼 아래로 증가하는 경우)")
    ap.add_argument("--no-keep-aspect", action="store_true", help="x, y 를 각각 따로 0..dac_max 에 맞춤")
    ap.add_argument("--margin", type=float, default=0.05, help="가장자리 여백 비율 (기본 0.05)")
    ap.add_argument("--dac-max", type=int, default=4095, help="DAC 최대 코드 (기본 4095)")
    ap.add_argument("--demo-frames", type=int, default=250)
    ap.add_argument("--demo-points", type=int, default=3000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--udp-port", type=int, help="UDP 수신 → /relay WebSocket 으로 전달")
    ap.add_argument("--tcp-port", type=int, help="TCP 수신(줄 단위) → /relay WebSocket 으로 전달")
    ap.add_argument("--verbose", action="store_true", help="요청 로그 출력")
    a = ap.parse_args(argv)
    for st in (sys.stdout, sys.stderr):           # Windows 콘솔(cp949 등)에서 출력 불가 문자로 중단되지 않게
        try:
            st.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    if a.parquet:
        t0 = time.perf_counter()
        src = ParquetSource(a.parquet, a.frame_col, a.x_col, a.y_col, fps=a.fps or 30.0, dac_max=a.dac_max,
                            keep_aspect=not a.no_keep_aspect, flip_y=a.flip_y, margin=a.margin)
        print("parquet: %s — %d 프레임, 총 %d 점, 최대 %d 점/프레임 (%.1f s)"
              % (a.parquet, src.frames, src.total_points, src.max_points, time.perf_counter() - t0))
        print("  " + src.mapping)
    else:
        src = DemoSource(frames=a.demo_frames, fps=a.fps or 25.0, max_points=a.demo_points, dac_max=a.dac_max)
        print("demo: %d 프레임, %g fps, 최대 %d 점/프레임" % (src.frames, src.fps, src.max_points))

    try:
        server = build_server(src, a.host, a.port, a.udp_port, a.tcp_port, a.verbose)
    except OSError as e:
        raise SystemExit("포트를 열 수 없습니다 (%s). 이미 실행 중인 서버가 있거나 다른 프로그램이 사용 중입니다. --port 로 변경하세요." % e)
    base = "http://%s:%d" % (a.host, a.port)
    print("HTTP API  : %s/api/info , %s/api/frame/0" % (base, base))
    print("WebSocket : ws://%s:%d/ws%s" % (a.host, a.port, "  ,  ws://%s:%d/relay" % (a.host, a.port) if server.relay else ""))
    if a.udp_port:
        print("UDP 중계  : udp://%s:%d → /relay" % (a.host, a.udp_port))
    if a.tcp_port:
        print("TCP 중계  : tcp://%s:%d (줄 단위) → /relay" % (a.host, a.tcp_port))
    print("종료: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
