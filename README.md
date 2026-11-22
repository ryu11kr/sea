# 물때첩 (sea)

버스첩과 같은 PWA 패턴으로, **바다 포인트 등록 → 물때·날씨 조회**를 제공합니다.

- 예정 도메인: [sea.uxpwa.com](https://sea.uxpwa.com)
- Git 리포지터리명: `sea` (버스첩 `bus`와 동일한 방식으로 배포)

## 로컬 실행

`serve.cmd` 더블클릭 (버스첩과 동일). 창에 `http://127.0.0.1:5177/` 주소가 표시됩니다.

```powershell
cd sea
.\serve.cmd
```

정적 화면만 확인할 때는 위 방식으로 충분합니다. **물때(`/api/tide`)·카카오 지오코딩**은 Vercel 서버리스가 필요합니다.

```powershell
cd sea
npx vercel dev
```

`.env` 또는 Vercel에 `KHOA_SERVICE_KEY`, `KAKAO_REST_KEY`를 넣으면 로컬에서도 조석·주소 검색이 동작합니다.

## 화면 흐름

1. **목록** — 포인트 없음 안내 + `새 포인트 등록`
2. **지도** — 주소 검색, 지도 이동, 중앙 핀 위치 저장
3. **상세** — 오늘 물때(조석) + 기상·파고

## 필요한 API (권장)

| 용도 | 추천 API | 키 발급 |
|------|----------|---------|
| **조석(물때)** | [국립해양조사원 Open API](https://www.khoa.go.kr/oceangrid/khoa/takepart/openapi/openApiInfoPage.do) — `tideObsPreTab` | 공공데이터포털 / KHOA |
| **날씨·풍속** | [Open-Meteo](https://open-meteo.com/) (브라우저 직접 호출, 키 불필요) | — |
| **파고** | [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) | — |
| **주소 검색·역지오코딩** | 카카오 로컬 API (한국 정확도 좋음) | [Kakao Developers](https://developers.kakao.com/) |
| **지도 타일** | 현재: OpenStreetMap + Leaflet (개발용). 운영 시 **카카오맵/네이버맵 JS SDK** 전환 권장 | 각 플랫폼 |
| **(대안) 기상청** | 기상청 단기예보 API (data.go.kr) | 공공데이터포털 |

### Vercel 환경 변수

| 변수 | 설명 |
|------|------|
| `KHOA_SERVICE_KEY` | KHOA 조석 예보 (서버 `/api/tide` 프록시) |
| `KAKAO_REST_KEY` | 주소 검색·역지오코딩 (`/api/geocode`). 없으면 Nominatim 폴백 |

## 배포

버스첩과 같이 Vercel에 프로젝트 루트를 `sea`로 연결하고, 도메인 `sea.uxpwa.com`을 CNAME으로 연결합니다.

```text
buildCommand: node scripts/vercel-build-version.mjs
outputDirectory: .
```

## 이후 확장 (버스첩 패리티)

- 구글 로그인 + Supabase 클라우드 백업 (`cloud-sync` 패턴)
- 포인트 공유
- 카카오맵 위성·바다 레이어
- 관측소가 멀 때 경고, 사리/조금 캘린더

## 아이콘

현재 `icons/`는 버스첩에서 임시 복사본입니다. 물때첩 전용 아이콘으로 교체하세요.