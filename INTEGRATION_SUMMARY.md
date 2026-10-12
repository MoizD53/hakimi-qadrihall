# Evan-e-Hakimi & Evan-e-Qadri Banquet Halls — Architecture & Integration Summary

## Overview
The booking and administrative management system is fully integrated across:
- **Frontend**: Vanilla HTML5, CSS3, ES6 JavaScript (`index.html`, `admin.html`, `pay.html`)
- **Backend**: Node.js & Express serverless API routes (`api/index.js` -> `backend/server.js`)
- **Database**: Turso (libSQL) Cloud Database via `@libsql/client` (`backend/db.js`)
- **Hosting Platform**: Vercel Serverless & Edge Network

---

## Technical Stack & Configuration

### 1. Database Integration (Turso / libSQL)
- Database client: `@libsql/client`
- Connection URL: `TURSO_DATABASE_URL` (libsql protocol in production, e.g., `libsql://your-db.turso.io`, or `file:local.db` for local SQLite development)
- Authentication Token: `TURSO_AUTH_TOKEN`
- Concurrency Management: Interactive libSQL write transactions (`db.transaction('write')`) ensure serialized slot booking operations without race conditions.

### 2. Deployment Architecture (Vercel)
- Entry point: `api/index.js` acts as the serverless function handler exporting the Express app (`backend/server.js`).
- Routing rules: Configured in `vercel.json`:
  - `/api/(.*)` routes to `/api/index.js`
  - `/admin` routes to `/admin.html`
  - `/pay` routes to `/pay.html`
  - Static assets and main page served from root (`/`)
- Dynamic Origin Handling (`js/config.js`):
  - When hosted on Vercel (`*.vercel.app` or a connected custom domain), `API_BASE_URL` automatically resolves to `window.location.origin`.
  - When in local live-server preview, defaults to `http://localhost:5000`.

---

## Core API Endpoints

### Public Endpoints
- `GET /health`: Health and database ping check.
- `GET /api/bookings/availability?date=YYYY-MM-DD`: Returns slot availability and status hierarchy (`confirmed_booked` > `conflict_blocked` > `pending_inquiry`).
- `POST /api/bookings`: Submits booking enquiry for Evan-e-Hakimi (rejects Evan-e-Qadri; validates server-side pricing: ₹11,000 without jaman, ₹15,000 with jaman, ₹30,000 full day).

### Admin Endpoints (Protected by JWT)
- `POST /api/admin/login`: Authenticates manager credentials (`ADMIN_USERNAME` and `ADMIN_PASSWORD`), returns JWT token.
- `GET /api/bookings`: Returns all booking enquiries.
- `GET /api/bookings/:id`: Returns booking details.
- `PATCH /api/bookings/:id/status`: Updates booking status (`confirmed`, `rejected`, `waiting`) inside a write transaction with conflict checking.
- `PATCH /api/bookings/:id/verify-advance`: Validates and marks 40% advance payment as verified.
- `PATCH /api/bookings/:id/paydone`: Records customer advance payment submission.

---

## Required Environment Variables (Vercel)
1. `TURSO_DATABASE_URL` — Turso database URL (`libsql://...`)
2. `TURSO_AUTH_TOKEN` — Turso authentication token
3. `JWT_SECRET` — Strong random secret for admin session tokens
4. `ADMIN_USERNAME` — Manager login username
5. `ADMIN_PASSWORD` — Manager login password
6. `ALLOWED_ORIGIN` — (Optional) custom domain if strict CORS is preferred
