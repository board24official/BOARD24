# BOARD24 새 설치 순서

1. Firebase 새 프로젝트 생성
2. 웹 앱 등록 후 `assets/firebase-config.js`에 config 입력
3. Authentication에서 **익명** 및 **이메일/비밀번호** 활성화
4. Realtime Database 생성 후 `database.rules.json` 내용을 규칙 탭에 게시
5. 로컬 검증 후 GitHub 새 저장소에 전체 폴더를 한 번만 업로드
6. GitHub Pages를 `main / (root)`로 설정

## 현재 보안 수준
이 규칙은 인증된 사용자만 접근 가능한 지인·베타 테스트용입니다. 참가자가 개발자 도구로 게임 상태를 조작하는 것까지 막지는 못합니다. 정식 앱 전에 게임 판정과 비공개 손패는 서버로 이전해야 합니다.
