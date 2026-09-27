# HANDOFF — 2026-09-27

## 한 일
- 사이드바 「리쿠르팅」에 **「리쿠르팅 소개」** 추가 (`web/index.html` `openRecruitIntro`, `web/assets/app.css` `.recruit-show`).
  누르면 `web/recruit/` 랜딩이 앱을 덮고 전체 화면으로 뜬다. 랜딩의 「나가기」로 돌아온다.
- 랜딩(`web/recruit/index.html` + `assets/`)은 insur-study 저장소에서 옮겨 왔다. 여기부터가 원본이다.
  보여주는 사람의 이름·직급·지점명을 BOOT에서 받아 서명·하단 문구·탭 제목·발표 멘트에 넣는다.
- CLAUDE.md 「리쿠르팅 소개」 절, docs/decisions.md 기록.

## 검증
- 임시 부모 페이지(BOOT 흉내)에서 열기 → 인트로 → 네 갈래 → 모달 넘김 → 마무리 서명
  「안창민 · 신한라이프 하랑지점 부지점장」, 탭 제목 → 「나가기」로 덮개 닫힘까지 헤드리스 크롬으로 확인. 페이지 오류 없음.
- 실제 로그인 앱에서는 아직 못 눌러 봤다(로그인 필요). 배포 후 한 번 눌러 확인할 것.

## 남은 것
- 배포 후 실제 계정으로 열어 서명 확인, 폰(아이폰·갤럭시)에서 덮개·나가기 확인.
- 인트로는 클로드 안(A안)으로 확정. 코덱스 비교 장치(?intro=b)는 뺐다.


## 2026-09-27 추가 — 배포 전 막힌 것 두 가지
- iframe 주소를 `recruit/` → `recruit/index.html`. 서버 정적 서빙은 확장자가 있는 파일만 보고, 폴더 주소는 API로 넘긴다 —
  `GET /recruit`(도입 현황)와 겹쳐 401이 났다.
- 정적 서빙 형식표에 jpg·jpeg·webp·woff2·mp4 추가(전에는 octet-stream). 서버를 다시 켜야 반영된다.
- 검증: `node test.js` 전체 통과. `node dev.js`로 실제 앱을 띄워 메뉴 → 랜딩 → 서명(dev 계정 「안창민 · 신한라이프 하랑지점 팀장」) → 나가기 확인.
- 배포: NCP 서버에서 `sudo bash /opt/ourbranch/server/setup.sh` (git pull + 서비스 재시작).
