# Evan-e-Hakimi & Evan-e-Qadri Banquet Halls - Project Status & PRD

## 📌 Project Overview
**Evan-e-Hakimi & Evan-e-Qadri Banquet Halls** is a booking and management system designed to handle hall enquiries, slot reservations, advance payment tracking, and management administration.

The system provides a responsive, gated reservation portal for community members and a secure administrative dashboard for hall managers.

---

## 🏗️ Technical Architecture & Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend (Customer)** | Vanilla HTML, CSS, JS | Responsive single page booking app (`index.html`) with 12 mandatory T&Cs |
| **Frontend (Admin)** | Vanilla HTML, CSS, JS | Secure control panel with real-time sync (`admin.html`) |
| **Backend API** | Node.js, Express (Vercel Serverless) | RESTful API managing slots, conflicts, validation, and JWT auth (`backend/server.js`) |
| **Database** | Turso (libSQL) | Serverless SQLite distributed database via `@libsql/client` (`backend/db.js`) |
| **Hosting Platform** | Vercel | Monorepo-style deployment for both static web pages and `/api` serverless routes |

---

## ✅ Current System Rules & Protections

1. **Hall Whitelist & Availability**:
   - **Evan-e-Hakimi (2nd Floor)**: Fully open for enquiries.
   - **Evan-e-Qadri (3rd Floor)**: Strictly unavailable; rejected by both frontend validation and backend API (`400 Bad Request`).

2. **Pricing Structure**:
   - **Morning Slot (10:30 AM – 2:30 PM)**: ₹11,000 (Without Jaman) / ₹15,000 (With Jaman)
   - **Evening Slot (6:30 PM – 10:30 PM)**: ₹11,000 (Without Jaman) / ₹15,000 (With Jaman)
   - **Full Day Slot (10:00 AM – 10:00 PM)**: ₹30,000

3. **Advance Payment**:
   - Exactly 40% non-refundable advance required upon manager approval.
   - Validated server-side on creation and payment verification.

4. **Slot Concurrency & Conflict Prevention**:
   - Full Day conflicts with Morning and Evening.
   - Morning and Evening can coexist on the same date.
   - All booking status updates and payment verifications run inside Turso libSQL exclusive write transactions (`db.transaction('write')`).

5. **Terms & Conditions Gating**:
   - Version: `hall_tc_version_v3`.
   - 12 comprehensive hall rules (capacity 35–40 thals, Aamil Saheb approval required, advance policy, noise, cleanliness, etc.).
   - Explicit "Agree & Continue" gate blocks user interaction until accepted.
