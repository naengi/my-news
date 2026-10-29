# 내 뉴스

나라(한국·미국·영국·일본)와 분야(경제·증시·정치·국제·산업·IT·사회)별로 뉴스를 모아,
Claude가 핵심만 요약하고 외국 기사는 제목과 요약을 한국어로 옮겨 보여주는 개인용 사이트입니다.
같은 소식을 여러 언론사가 보도하면 신뢰도가 가장 높은 곳(`feeds.json`의 `trust`, 숫자가 작을수록 우선)의 기사 하나만 요약하고, 나머지 언론사 이름은 카드에 "같은 소식 보도"로 표시합니다.

- 기사 카드: 언론사 · 시간 · 제목 · 요약 · **기사 링크 ↗** (외국 기사는 원래 제목도 함께 표시)
- 기사 원문은 요약할 때만 읽고 저장하지 않음. 공개 사이트에는 요약과 링크만 올라감
- 휴대폰에서 "홈 화면에 추가"하면 앱처럼 쓸 수 있음 (PWA)

## 동작 방식

GitHub Actions가 2시간마다 `scripts/update.mjs`를 실행합니다.

1. `feeds.json`에 적힌 언론사 RSS에서 새 기사를 가져옴
2. 기사 페이지에서 본문을 읽음 (실패하면 RSS 설명으로 대체, 저장은 안 함)
3. Claude API로 요약·번역 (이미 요약한 기사는 다시 요약하지 않음)
4. `public/data/*.json`에 저장하고 GitHub Pages로 배포

## 처음 설정 (한 번만)

1. GitHub에 새 저장소를 만들고 이 폴더 내용을 올립니다.
2. 저장소 **Settings → Secrets and variables → Actions** 에서
   - Secret `ANTHROPIC_API_KEY` 추가 (https://console.anthropic.com 에서 발급)
   - (선택) Variable `NEWS_MODEL` 로 모델 지정. 비워두면 `claude-haiku-5-5`, 품질을 더 올리려면 `claude-opus-5-5` (비용 약 30배)
3. **Settings → Pages → Source** 를 "GitHub Actions"로 바꿉니다.
4. **Actions → 뉴스 업데이트 → Run workflow** 로 한 번 돌리면 사이트 주소가 나옵니다.

## 고치고 싶을 때

- 언론사·나라·분야 추가/삭제, 언론사 신뢰도 순서: `feeds.json`
- 피드당 가져올 기사 수 `perFeed`, 분야별 보관 개수 `keepPerSection`
- 한 번에 요약할 최대 기사 수: 환경변수 `MAX_NEW_ARTICLES` (기본 120)
- 내 컴퓨터에서 실행: `npm install && ANTHROPIC_API_KEY=... npm run update && npm run serve`
