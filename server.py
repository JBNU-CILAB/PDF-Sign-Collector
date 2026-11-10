#!/usr/bin/env python3
"""PDF 서명 공유 서버 (Python 표준 라이브러리만 사용).

  python3 server.py [--host 0.0.0.0] [--port 8000] [--data ./data]

API
  POST /api/docs                 (body: PDF, header X-Filename)  -> {id, version}
  GET  /api/docs                 -> 전체 문서 목록 (서버 컴퓨터에서만)
  GET  /api/docs/<id>            -> 메타데이터 {id, name, version, history}
  GET  /api/docs/<id>/pdf        -> 최신 PDF  (?v=N 으로 특정 버전)
  PUT  /api/docs/<id>/pdf        (body: PDF, X-Base-Version, X-Signer) -> {version}
                                 기준 버전이 최신이 아니면 409
                                 X-Replace: 1 이면 다른 PDF 로 문서 교체 (서버 컴퓨터에서만, 버전 확인 없음)
  GET  /api/config               -> {publicUrl, canUpload}

새 문서 업로드(POST)는 기본적으로 이 컴퓨터(localhost)에서만 허용.
다른 사람은 공유 링크로 기존 문서를 열어 서명만 할 수 있음 (--allow-remote-upload 로 해제).
"""
import argparse
import json
import os
import re
import secrets
import socket
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs

MAX_BYTES = 50 * 1024 * 1024
ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,40}$")
LOCK = threading.Lock()
DATA = os.path.join(ROOT, "data")
PUBLIC_URL = ""            # 공유 링크에 쓸 외부 주소 (예: http://1.2.3.4:8000)
ALLOW_REMOTE_UPLOAD = False
LOG_ALL = False            # --log-all: 모든 요청 기록 (접속 문제 진단용)
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
# 터널/프록시(cloudflared, tailscale funnel 등)를 거친 요청은 localhost 에서 온 것처럼 보이므로 제외
PROXY_HEADERS = ("X-Forwarded-For", "Forwarded", "Cf-Connecting-Ip", "Tailscale-Funnel-Request")


def doc_dir(doc_id):
    return os.path.join(DATA, doc_id)


def load_meta(doc_id):
    with open(os.path.join(doc_dir(doc_id), "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def save_meta(doc_id, meta):
    p = os.path.join(doc_dir(doc_id), "meta.json")
    tmp = p + ".tmp"

    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    os.replace(tmp, p)


def list_docs():
    docs = []
    for doc_id in os.listdir(DATA):
        if not ID_RE.match(doc_id) or not os.path.isfile(os.path.join(doc_dir(doc_id), "meta.json")):
            continue

        try:
            m = load_meta(doc_id)
        except (OSError, ValueError):
            continue

        h = m["history"]
        # 마지막 문서 교체 이후의 서명만 현재 파일에 들어 있음
        start = max((i for i, e in enumerate(h) if e["action"].startswith("문서 교체")), default=0)
        signs = [e for e in h[start:] if e["action"].startswith("서명")]
        docs.append({"id": doc_id, "name": m["name"], "version": m["version"],
                     "created": h[0]["at"], "updated": h[-1]["at"],
                     "signers": [e["by"] for e in signs]})

    docs.sort(key=lambda d: d["updated"], reverse=True)
    return docs


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
    }

    def end_headers(self):
        # 정적 파일(html/css/js)은 매번 변경 여부 확인 → 업데이트 후 옛 파일이 캐시에 남지 않게
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")

        super().end_headers()

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_pdf_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            self.send_json({"error": f"파일 크기 오류 (최대 {MAX_BYTES // 2**20}MB)"}, 413)
            return None

        data = self.rfile.read(n)
        if not data.startswith(b"%PDF"):
            self.send_json({"error": "PDF 파일이 아닙니다"}, 400)
            return None

        return data

    def is_local(self):
        return (self.client_address[0] in LOOPBACK
                and not any(self.headers.get(h) for h in PROXY_HEADERS))

    def route(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/docs(?:/([^/]+))?(/pdf)?/?$", path)
        if not m:
            return None

        doc_id, is_pdf = m.group(1), bool(m.group(2))
        if doc_id is not None and (not ID_RE.match(doc_id) or not os.path.isdir(doc_dir(doc_id))):
            self.send_json({"error": "문서를 찾을 수 없습니다"}, 404)
            return False

        return doc_id, is_pdf

    def log_message(self, fmt, *args):
        req = str(args[0]) if args else ""
        if LOG_ALL or req.startswith(("POST /api/", "PUT /api/")) or (len(args) > 1 and str(args[1])[:1] in "45"):
            super().log_message(fmt, *args)

    # ---------- methods ----------
    def do_GET(self):
        if urlparse(self.path).path == "/api/config":
            return self.send_json({"publicUrl": PUBLIC_URL,
                                   "canUpload": ALLOW_REMOTE_UPLOAD or self.is_local(),
                                   "canManage": self.is_local()})

        r = self.route()
        if r is None:
            if urlparse(self.path).path.startswith("/d/"):
                self.path = "/index.html"  # 공유 링크 /d/<id> -> SPA
            return super().do_GET()

        if r is False:
            return

        doc_id, is_pdf = r
        if doc_id is None:
            # 목록은 모든 문서 ID(=접근 권한)를 드러내므로 서버 컴퓨터에서만
            if not self.is_local():
                return self.send_json({"error": "문서 목록은 서버 컴퓨터에서만 볼 수 있습니다"}, 403)
            return self.send_json(list_docs())

        meta = load_meta(doc_id)
        if not is_pdf:
            return self.send_json(meta)

        q = parse_qs(urlparse(self.path).query)
        v = int(q.get("v", [meta["version"]])[0])
        if not 1 <= v <= meta["version"]:
            return self.send_json({"error": "버전 없음"}, 404)

        with open(os.path.join(doc_dir(doc_id), f"v{v}.pdf"), "rb") as f:
            data = f.read()

        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Version", str(v))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if urlparse(self.path).path == "/api/clientlog":
            # 브라우저에서 난 오류를 서버 콘솔에 남김 (원격 접속 문제 진단용)
            n = min(int(self.headers.get("Content-Length") or 0), 2000)
            msg = self.rfile.read(n).decode("utf-8", "replace").replace("\n", " | ")
            self.log_message("클라이언트 오류: %s", msg)
            self.send_response(204)
            self.end_headers()
            return

        r = self.route()
        if not r or r[0] is not None or r[1]:
            return self.send_json({"error": "잘못된 요청"}, 404) if r is not False else None
        if not (ALLOW_REMOTE_UPLOAD or self.is_local()):
            return self.send_json({"error": "새 문서 업로드는 서버 컴퓨터에서만 할 수 있습니다"}, 403)

        data = self.read_pdf_body()
        if data is None:
            return

        name = unquote(self.headers.get("X-Filename") or "document.pdf")[:200]
        doc_id = secrets.token_urlsafe(9)
        with LOCK:
            os.makedirs(doc_dir(doc_id))
            with open(os.path.join(doc_dir(doc_id), "v1.pdf"), "wb") as f:
                f.write(data)
            meta = {"id": doc_id, "name": name, "version": 1,
                    "history": [{"version": 1, "action": "업로드", "by": "", "at": time.time()}]}
            save_meta(doc_id, meta)

        self.send_json(meta, 201)

    def do_PUT(self):
        r = self.route()
        if not r or r[0] is None or not r[1]:
            return self.send_json({"error": "잘못된 요청"}, 404) if r is not False else None

        doc_id = r[0]
        replace = self.headers.get("X-Replace") == "1"
        if replace and not (ALLOW_REMOTE_UPLOAD or self.is_local()):
            return self.send_json({"error": "문서 교체는 서버 컴퓨터에서만 할 수 있습니다"}, 403)

        data = self.read_pdf_body()
        if data is None:
            return

        try:
            base = int(self.headers.get("X-Base-Version") or 0)
        except ValueError:
            base = 0

        signer = unquote(self.headers.get("X-Signer") or "")[:100]
        count = self.headers.get("X-Sign-Count") or "?"
        with LOCK:
            meta = load_meta(doc_id)
            if not replace and base != meta["version"]:
                return self.send_json({"error": "다른 사용자가 먼저 저장했습니다",
                                       "version": meta["version"]}, 409)

            v = meta["version"] + 1
            with open(os.path.join(doc_dir(doc_id), f"v{v}.pdf"), "wb") as f:
                f.write(data)

            meta["version"] = v
            if replace:  # 이전 버전 파일은 그대로 보존 (?v=N 으로 받을 수 있음)
                meta["name"] = unquote(self.headers.get("X-Filename") or meta["name"])[:200]
                action = f"문서 교체 ({meta['name']})"
            else:
                action = f"서명 {count}개 추가"

            meta["history"].append({"version": v, "action": action,
                                    "by": signer, "at": time.time()})
            save_meta(doc_id, meta)

        self.send_json(meta)


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass

    return sorted(ips)


def main():
    global DATA, PUBLIC_URL, ALLOW_REMOTE_UPLOAD, LOG_ALL

    ap = argparse.ArgumentParser(description="PDF 서명 공유 서버")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--data", default=DATA, help="문서 저장 폴더")
    ap.add_argument("--public-url", default="",
                    help="공유 링크에 쓸 외부 주소 (기본: http://<이 컴퓨터 IP>:<포트>, 터널 사용 시 그 https 주소)")
    ap.add_argument("--allow-remote-upload", action="store_true",
                    help="다른 컴퓨터에서도 새 문서 업로드 허용")
    ap.add_argument("--log-all", action="store_true", help="모든 요청 기록 (접속 문제 진단용)")

    a = ap.parse_args()

    DATA = os.path.abspath(a.data)
    ALLOW_REMOTE_UPLOAD = a.allow_remote_upload
    LOG_ALL = a.log_all

    os.makedirs(DATA, exist_ok=True)
    ips = lan_ips()
    PUBLIC_URL = (a.public_url or (f"http://{ips[0]}:{a.port}" if ips else "")).rstrip("/")
    srv = ThreadingHTTPServer((a.host, a.port), Handler)

    print(f"PDF 서명 서버 실행 중 (데이터: {DATA})")
    print(f"  이 컴퓨터(문서 올리기): http://localhost:{a.port}/")

    for ip in ips:
        print(f"  같은 네트워크:          http://{ip}:{a.port}/")

    print(f"  공유 링크 주소:         {PUBLIC_URL or '(알 수 없음, --public-url 지정)'}")
    if not ALLOW_REMOTE_UPLOAD:
        print("  새 문서 업로드는 이 컴퓨터에서만 가능 (--allow-remote-upload 로 해제)")

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
