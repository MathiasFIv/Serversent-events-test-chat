# Client (React + Vite)

This is the frontend for the ASP.NET backend in `../server`.

## Backend endpoints

- SSE stream: `GET /thechat/stream`
- Send message: `POST /thechat/send` with JSON: `{ "content": "hello" }`

In dev, Vite proxies `/thechat` to the backend running on `http://localhost:5107`.

## Run (development)

1) Start the server (from repo root):

```powershell
cd server
dotnet run
```

2) Start the client (from repo root):

```powershell
cd client
npm install
npm run dev
```

Then open the Vite URL (usually `http://localhost:5173`).

## Notes

- The chat UI uses `EventSource('/thechat/stream')` for live updates.
- If you change the server port, update `client/vite.config.js`.
