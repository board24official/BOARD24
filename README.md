> CLEAN BASELINE: 새 Firebase 프로젝트와 연결해 사용하는 GitHub Pages용 전체본입니다.

# BOARD 24 — GitHub Pages 배포본

원본(`board.zip`, v2.9.47)에서 GitHub Pages에 올릴 수 있도록 서버 전용 파일만 제외하고 정리했습니다.
`index.html`, `ladder.html`, `onecard.html`, `outlaw.html`, `pass.html`, `assets/` 등 실제 화면·로직 파일은 원본 그대로입니다.

## 제외한 파일 (아파치/PHP 전용, GitHub Pages에서 쓰이지 않음)

- `api.php` — 서버 동기화 엔드포인트
- `.htaccess`, `data/.htaccess` — 아파치 설정
- `data/game-state.json`, `data/game-state.lock`, `data/index.html` — 서버 저장소
- `README.md`, `VERSION.txt`, `INVITE_UPDATE.txt` — 닷홈 FTP 배포용 원본 문서 (이 파일로 대체)

## 백엔드 동작 방식 (변경 없음)

`assets/core.js`가 아래 순서로 자동 전환됩니다.

1. `api.php` 시도 — GitHub Pages엔 PHP가 없으므로 **항상 실패하고 자동으로 다음 단계로 넘어갑니다.**
2. `assets/firebase.js`의 `FIREBASE_CONFIG`가 채워져 있으면 Firebase로 실시간 동기화
3. 둘 다 없으면 로컬 모드 (같은 브라우저 탭 간에만 동기화, 기기 간 공유 불가)

**여러 사람이 다른 기기에서 함께 하려면 Firebase 설정이 꼭 필요합니다.**
`assets/firebase.js` 맨 위 주석에 있는 순서대로 `FIREBASE_CONFIG` 값을 채우고 커밋하면 됩니다.

## 추가한 기능 — 초대 링크로 같이 하기

실시간 초대(폴링) 기능 대신, **자료실을 만들면 초대 링크가 자동으로 클립보드에 복사**됩니다.
- 방장이 자료실을 만들면 `index.html?room=자료실ID` 형태의 링크가 복사됩니다. (로비, 게임 대기실 어디서든 "🔗 초대 링크 복사" 버튼으로 다시 복사 가능)
- 그 링크를 카카오톡 등으로 보내면, 받은 사람이 클릭 → (처음이면 이름 입력) → 자동으로 그 자료실에 들어갑니다.
- 접근 코드가 걸린 방이면 입장 시 코드를 한 번 물어봅니다.

**단, 이 기능이 실제로 동작하려면 Firebase 온라인 모드가 반드시 켜져 있어야 합니다.** 로컬 모드(Firebase 미설정)에서는 자료실이 방장의 브라우저 안에만 존재하기 때문에, 다른 사람 기기에서는 링크를 열어도 "자료실을 찾을 수 없습니다"라고 나옵니다.

## 이번 배포본에서 참고로 동작이 달라지는 부분

원본은 PHP 서버가 있다는 전제로 만들어진 부가 기능이 몇 가지 있습니다. GitHub Pages(서버 없음)에서는 아래 기능만 **자동으로, 조용히** 비활성화됩니다 (에러 화면 없이 그냥 동작 안 함):

- 로비 상단 **관리자(ADMIN)** 패널 — 방 관전/강제 퇴장/세션 초기화 등
- 로비 내 **실시간 초대(invite)** 배지 — 5초마다 `api.php`를 조용히 호출하다 실패
- 게임 중 사용자 초대 기능

Firebase 모드로 전환하면 방 생성/참여/실시간 플레이 등 핵심 기능은 그대로 정상 동작합니다. 위 부가 기능까지 되살리려면 별도로 Firebase 기반으로 다시 구현해야 합니다.

## GitHub Pages로 배포하기

```bash
cd board24            # 이 폴더
git init
git add .
git commit -m "Deploy BOARD 24 to GitHub Pages"
git branch -M main
git remote add origin https://github.com/<사용자명>/board24.git
git push -u origin main
```

GitHub 저장소 → **Settings → Pages**
- Source: **Deploy from a branch**
- Branch: `main` / `/(root)`
- 저장 후 1~2분 뒤 `https://<사용자명>.github.io/board24/` 에서 접속 가능

## 접근 제한

저장소를 **Public**으로 만들면 GitHub Pages가 무료로 동작하지만 누구나 URL로 접속할 수 있습니다.
접근을 제한하려면:
- Private 저장소 + GitHub Pro/Team 이상 요금제, 또는
- Firebase Authentication으로 앱 자체에 로그인 게이트 추가
