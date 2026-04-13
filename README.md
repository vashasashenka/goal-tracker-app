# Goal Tracker

## Local Run

Frontend:

1. Copy `.env.example` to `.env`
2. Set `VITE_API_URL` (default `http://localhost:5001`)
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
- Backend accepts CORS origins from `CORS_ORIGIN`.
  - Single origin: `https://your-frontend.app`
  - Multiple origins: `https://a.app,https://b.app`
- Backend port can be overridden with `PORT`.
