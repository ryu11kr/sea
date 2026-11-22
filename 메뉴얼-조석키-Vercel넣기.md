# 조석(물때) API 키 — Vercel에 넣기

앱 상세 화면에 **「조석 API 키 미설정」** 이 보이면, 서버(Vercel)에
**`KHOA_SERVICE_KEY`** 가 없다는 뜻입니다. 날씨(Open-Meteo)는 키 없이 되지만,
물때는 **국립해양조사원(KHOA) Open API** 키가 필요합니다.

## 1단계 — 공공데이터 / 해양 API 신청

1. 브라우저에서 [해양수산부 국립해양조사원 해양정보 Open API](https://www.khoa.go.kr/oceangrid/khoa/takepart/openapi/openApiInfoPage.do) 또는
   [공공데이터포털](https://www.data.go.kr) 에서 **조석 예보·조화현상** 관련 API를 찾습니다.
2. API 이름이 **`tideObsPreTab`**(조석 예보·관측 전·후) 계열인지 확인합니다. (물때첩 `api/tide.js`가 이 API를 호출합니다.)
3. 활용 신청 후 **일반 인증키(Encoding)** 또는 서비스 키를 받습니다.
4. 키를 메모장에 복사해 둡니다. (Git·카톡에 올리지 마세요.)

> 공공데이터에서 받은 키는 `DATA_GO_KR_SERVICE_KEY` 이름으로도 Vercel에 넣을 수 있습니다.

## 2단계 — Vercel 환경 변수

1. [Vercel 대시보드](https://vercel.com) 로그인
2. **sea** 프로젝트 선택 (GitHub `ryu11kr/sea` 와 연결된 것)
3. **Settings** → **Environment Variables**
4. 새 변수 추가:
   - **Name:** `KHOA_SERVICE_KEY`
   - **Value:** 마이페이지에 보이는 **일반 인증키 한 줄** 전체 (신규 API는 Decoding/Encoding 구분이 없는 경우가 많습니다).
   - End Point 가 `https://apis.data.go.kr/1192136/surveyTideLevel/...` 이면 **2025년 이후 공공데이터 형식**입니다. 예전 `khoa.go.kr/oceangrid/...` 와는 URL이 다릅니다.
   - **Environment:** Production (로컬 `vercel dev` 쓸 때는 Preview/Development도 체크)
5. **Save**

## 3단계 — 다시 배포

환경 변수만 넣고 끝나지 않습니다. **새 배포**가 한 번 필요합니다.

- Vercel → **Deployments** → 맨 위 배포 옆 **⋯** → **Redeploy**  
  또는 GitHub에 코드를 push 하면 자동 배포됩니다.

## 4단계 — 확인

1. https://sea.uxpwa.com 접속
2. **아암2교** 포인트 상세로 들어갑니다.
3. **오늘의 물때** 에 만조/간조 시간이 나오면 성공입니다.
4. 아래 주소를 브라우저 주소창에 넣어 볼 수도 있습니다. (`날짜`는 오늘 YYYYMMDD)

   `https://sea.uxpwa.com/api/tide?lat=위도&lon=경도&date=20261122`

   - `"configured": false` → 키가 아직 없거나 배포가 안 됨
   - `"configured": true` + `items` 배열 → 정상

## (선택) 카카오 주소 검색

지도에서 **한국 주소 검색**을 더 정확히 하려면:

- [Kakao Developers](https://developers.kakao.com/) → REST API 키
- Vercel에 **`KAKAO_REST_KEY`** 추가 후 Redeploy

없어도 Nominatim 폴백으로 동작하지만, 느리거나 검색이 어긋날 수 있습니다.

## 로컬에서 물때까지 볼 때

`serve.cmd`만으로는 `/api/tide` 가 안 됩니다.

```powershell
cd sea
npx vercel dev
```

프로젝트 루트에 `.env` 파일 (git에 올리지 말 것):

```env
KHOA_SERVICE_KEY=여기에_키
```