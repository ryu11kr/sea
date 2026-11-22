# 물때첩 — 구글 로그인(포인트 보관)

버스첩과 같은 Supabase 프로젝트를 써도 되고, 새 프로젝트를 만들어도 됩니다.

## 1. Supabase SQL

`supabase/sea-cloud-setup.sql` 내용을 Supabase **SQL Editor**에서 한 번 실행합니다.

## 2. Google OAuth (Supabase)

1. Supabase 대시보드 → **Authentication** → **Providers** → **Google** 활성화
2. Google Cloud Console에서 OAuth 클라이언트 만들기 (웹)
3. **Authorized redirect URI**: Supabase가 안내하는 콜백 URL 사용
4. Supabase **URL Configuration**에 사이트 URL: `https://sea.uxpwa.com/` (로컬 테스트 시 `http://localhost:5177/` 추가)

## 3. Vercel 환경 변수

| 이름 | 값 |
|------|-----|
| `SUPABASE_URL` | 프로젝트 URL |
| `SUPABASE_ANON_KEY` | anon public key |

배포 시 `scripts/vercel-build-version.mjs`가 `cloud-sync.runtime.json`을 생성합니다. **Redeploy** 한 번 해 주세요.

## 4. 확인

1. 목록 화면 **포인트 보관** → **구글로 로그인**
2. 포인트 저장 후 다른 기기(또는 시크릿 창)에서 같은 계정으로 로그인 → 목록이 맞는지 확인

로컬에서는 `cloud-sync.runtime.json`이 없으면 로그인 UI만 숨겨지고, 이 기기 저장은 그대로 동작합니다.