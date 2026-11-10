# 외부 라이브러리 출처

이 폴더의 JavaScript 파일은 외부 오픈소스 라이브러리의 **공식 배포 파일을 수정 없이** 그대로 복사한 것입니다.
인터넷 없이도 앱이 동작하도록 저장소에 직접 포함했습니다. 직접 고치지 마세요.

| 파일 | 라이브러리 | 버전 | 라이선스 | 앱에서의 용도 |
|---|---|---|---|---|
| `pdf.min.js` | pdf.js (`pdfjs-dist`) | 3.11.174 | Apache-2.0 | PDF 페이지를 화면(canvas)에 그리기, 좌표 변환 |
| `pdf.worker.min.js` | pdf.js (`pdfjs-dist`) | 3.11.174 | Apache-2.0 | PDF 해석 작업용 웹 워커 (`pdf.min.js`와 버전이 반드시 같아야 함) |
| `pdf-lib.min.js` | pdf-lib | 1.17.1 | MIT | 서명 이미지를 PDF 페이지에 합쳐 새 PDF 저장 |

## 출처

| 파일 | 내려받은 주소 | 원본 저장소 |
|---|---|---|
| `pdf.min.js` | https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js | https://github.com/mozilla/pdf.js |
| `pdf.worker.min.js` | https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js | https://github.com/mozilla/pdf.js |
| `pdf-lib.min.js` | https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js | https://github.com/Hopding/pdf-lib |

## 라이선스 파일

- `LICENSE-pdfjs.txt`: pdf.js의 Apache License 2.0 전문 (`pdfjs-dist@3.11.174/LICENSE`)
- `LICENSE-pdf-lib.md`: pdf-lib의 MIT License (`pdf-lib@1.17.1/LICENSE.md`).
  `pdf-lib.min.js` 안에는 pdf-lib 자체의 저작권 고지가 들어 있지 않아서 별도 파일로 둡니다.
  (파일 안의 Apache-2.0 고지는 pdf-lib에 함께 묶인 보조 라이브러리의 것입니다.)

## 무결성 확인

2026-11-10에 위 주소의 공식 파일과 SHA-256 해시를 비교해 **세 파일 모두 동일**함을 확인했습니다.

```
5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946  pdf.min.js
feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b  pdf.worker.min.js
0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f  pdf-lib.min.js
```

다시 확인하려면 이 폴더에서:

```
sha256sum pdf.min.js pdf.worker.min.js pdf-lib.min.js
```

## 업데이트할 때 주의

- **pdf.js는 3.x에 머물러 있습니다.** 4.0부터는 배포 파일이 ES 모듈(`pdf.min.mjs`)로만 나오고
  전역 변수 `pdfjsLib`를 만들지 않습니다. 4.x 이상으로 올리려면 `index.html`의 `<script>` 태그와
  `app.js`의 `pdfjsLib` 사용 부분을 함께 고쳐야 합니다.
- `pdf.min.js`와 `pdf.worker.min.js`는 항상 **같은 버전**으로 함께 바꿔야 합니다.
- 파일을 바꾸면 이 문서의 버전, 주소, 해시도 같이 갱신하세요.

## 알려진 보안 문제

pdf.js 4.2.67 미만(이 폴더의 3.11.174 포함)에는 **CVE-2024-4367**이 있습니다. 조작된 PDF를 열면
브라우저에서 임의의 JavaScript가 실행될 수 있는 취약점입니다. 이 앱에서는 서명하는 사람이 저장하는
PDF가 그대로 다른 사람 화면에 열리므로 영향을 받습니다.

**대응 (적용됨):** `app.js`의 `openPdf()`가 모든 PDF를 `isEvalSupported: false` 옵션으로 엽니다.
이 옵션이 취약점이 이용하는 코드 생성 경로를 꺼서 pdf.js를 올리지 않고도 막힙니다.
PDF를 여는 코드를 새로 추가할 때는 `pdfjsLib.getDocument()`를 직접 부르지 말고 `openPdf()`를 쓰세요.
