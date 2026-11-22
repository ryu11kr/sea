# 조석(물때) API 키 — Vercel에 넣기 (초보자용)

물때는 **브라우저가 아니라 Vercel 서버**가 공공데이터 API를 호출합니다.  
그래서 공공데이터에서 받은 **일반 인증키**를 Vercel에 `KHOA_SERVICE_KEY` 이름으로 넣어야 합니다.

**Decoding / Encoding 두 줄이 없어도 됩니다.** 마이페이지에 **일반 인증키 한 줄**만 있으면 그걸 씁니다.

---

## A. 공공데이터에서 키 복사하기

### 1) 포털 접속

1. 브라우저에서 https://www.data.go.kr 접속
2. 로그인 (신청할 때 쓴 계정)

### 2) 마이페이지로 이동

1. 오른쪽 위 **마이페이지** 클릭  
   (또는 상단 메뉴 **마이페이지 → 오픈API**)

### 3) 신청한 API 찾기

1. **오픈API** 메뉴
2. **개발계정** 또는 **활용신청 목록**에서 아래 이름 찾기:

   **「해양수산부 국립해양조사원_조위관측소 실측·예측 조위 조회」**

3. 그 줄을 클릭해서 **상세** 화면으로 들어감

### 4) 승인 상태 확인

- **처리상태**가 **「승인」** 이어야 합니다.  
  「신청」「검토중」이면 키가 있어도 API가 막힐 수 있습니다.

### 5) 일반 인증키 복사

상세 화면 아래 **「서비스정보」** 또는 **「활용신청 상세」** 에서:

| 항목 | 확인 |
|------|------|
| **End Point** | `https://apis.data.go.kr/1192136/surveyTideLevel/...` 비슷하면 OK |
| **일반 인증키** | 긴 문자열 한 줄 (예: `6fda...` 처럼 영문+숫자) |

복사 방법:

1. 인증키 오른쪽 **「복사」** 버튼이 있으면 그걸 누름  
2. 없으면 인증키 **전체를 마우스로 드래그** → `Ctrl+C`  
3. 메모장에 `Ctrl+V` 해서 **앞뒤 공백·줄바꿈 없는지** 확인

주의:

- 키 **일부만** 복사하지 말 것 (끝까지 전부)
- **따옴표** `"` 는 넣지 말 것
- GitHub, 카톡, 스크린샷 공개에 올리지 말 것 (유출 위험)

---

## B. Vercel에 넣기 (한 글자씩 따라하기)

### 1) Vercel 로그인

1. https://vercel.com 접속
2. GitHub로 로그인했던 계정으로 들어가기

### 2) sea 프로젝트 열기

1. 대시보드 **Projects** 목록에서 **`sea`** 클릭  
   - 이름이 다르면: `sea.uxpwa.com` 도메인이 연결된 프로젝트를 고름

### 3) Settings → Environment Variables

1. 프로젝트 상단 탭 **「Settings」** (설정)
2. 왼쪽 메뉴 **「Environment Variables」** (환경 변수)

### 4) 변수 추가 또는 수정

**처음 넣는 경우:**

1. **「Add New」** 또는 **「Add」** 클릭
2. 아래처럼 입력:

| 칸 | 넣을 내용 |
|----|-----------|
| **Key** (이름) | `KHOA_SERVICE_KEY` — 대소문자·언더스코어 정확히 |
| **Value** (값) | 메모장에 둔 **일반 인증키 전체** 붙여넣기 (`Ctrl+V`) |

3. **Environment** (환경) 체크:

   - **Production** → 반드시 체크 (실제 `sea.uxpwa.com`)
   - **Preview** → 나중에 미리보기 배포 쓸 때만
   - **Development** → `vercel dev` 로 로컬 API 테스트할 때만

   지금은 **Production만** 체크해도 됩니다.

4. **Save** 클릭

**이미 `KHOA_SERVICE_KEY` 가 있는 경우:**

1. 목록에서 `KHOA_SERVICE_KEY` 찾기
2. **Edit** (연필 아이콘) 클릭
3. **Value** 를 지우고 공공데이터에서 **다시 복사한 키** 로 통째로 교체
4. **Save**

**흔한 실수:**

| 실수 | 결과 |
|------|------|
| 이름을 `KHOA_SERVICE_KEY` 가 아니게 씀 | 서버가 키를 못 찾음 |
| Production 체크 안 함 | 사이트만 안 됨 |
| 키 앞뒤에 스페이스 | 인증 실패 |
| 키만 저장하고 Redeploy 안 함 | 예전 배포가 계속 돌아감 |

---

## C. Redeploy (반드시 필요)

환경 변수는 **「다음 배포부터」** 서버에 붙습니다. 저장만 하고 끝내면 안 됩니다.

1. Vercel 프로젝트 상단 **「Deployments」** 탭
2. 맨 위(가장 최근) 배포 줄 오른쪽 **「⋯」** (점 세 개)
3. **「Redeploy」** 클릭
4. 확인 창에서 다시 **Redeploy**
5. **Building → Ready** 될 때까지 1~3분 대기 (초록색 Ready)

GitHub에 코드 push 하면 자동 배포도 되는데, **키만 바꿨을 때는 Redeploy가 가장 확실**합니다.

---

## D. 잘 됐는지 확인

### 방법 1 — 브라우저 테스트 URL

1. 새 탭 주소창에 붙여넣기 (날짜·좌표는 예시, 오늘 날짜로 바꿔도 됨):

   ```
   https://sea.uxpwa.com/api/tide?lat=35.44&lon=129.35&date=20251122
   ```

2. 화면에 JSON 글자가 보임:

   - `"configured": true` 이고 `"items": [ ... ]` 안에 시간이 여러 개 → **성공에 가깝**
   - `"configured": false` → Vercel에 키 없음 또는 이름 오타
   - `"configured": true` 인데 `"items": []` + `"error"` → 키 오류·승인 안 됨·API 문제 (키 전체 재복사 후 Redeploy)

### 방법 2 — 앱에서 보기

1. https://sea.uxpwa.com 접속
2. **Ctrl+F5** (강력 새로고침)
3. **아암2교** 포인트 상세
4. **오늘의 물때** 에 만조·간조 시간이 보이면 OK

---

## E. 용어 정리

| 말 | 의미 |
|----|------|
| **일반 인증키** | 공공데이터 마이페이지에 보이는 API 비밀번호 같은 것 |
| **KHOA_SERVICE_KEY** | Vercel에 우리가 정한 **변수 이름** (코드가 이 이름을 읽음) |
| **Production** | 실제 사용자가 쓰는 `sea.uxpwa.com` 서버 |
| **Redeploy** | 같은 코드로 서버를 다시 켜서, 새 환경 변수를 반영하는 것 |

---

## (선택) 카카오 주소 검색

지도 **한국 주소 검색** 정확도:

- [Kakao Developers](https://developers.kakao.com/) → REST API 키
- Vercel에 **`KAKAO_REST_KEY`** 추가 → Save → Redeploy

## 로컬에서 물때까지

`serve.cmd`만으로는 `/api/tide` 가 없습니다.

```powershell
cd sea
npx vercel dev
```

`sea` 폴더에 `.env` (git에 올리지 말 것):

```env
KHOA_SERVICE_KEY=여기에_일반_인증키_한_줄
```