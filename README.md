# Goal Tracker

## Local Run

Frontend:

1. Copy `.env.example` to `.env`
2. Optionally set `VITE_API_URL` if backend is not available on the same origin
3. Run:

```bash
npm install
npm run dev
```

Backend:

1. Copy `backend/.env.example` to `backend/.env`
2. Fill DB and Yandex AI variables
3. Run:

```bash
cd backend
npm install
npm run dev
```

## Deploy Notes

- Frontend uses `VITE_API_URL` for backend URL.
- If `VITE_API_URL` is empty, frontend uses relative `/api` requests.
- In local Vite dev mode, `/api` is proxied to `http://localhost:5001` by default.
- Backend accepts CORS origins from `CORS_ORIGIN`.
  - Single origin: `https://your-frontend.app`
  - Multiple origins: `https://a.app,https://b.app`
- Backend port can be overridden with `PORT`.
