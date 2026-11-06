# Ymo Express

A food delivery marketplace with two kinds of accounts: **customers** who order, and **vendors** (restaurants) who sell. Frontend (`public/index.html`) and backend (`server.js`) live in one project.

## Run it
1. Install Node.js 20 or newer.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env`. Set `SESSION_SECRET` to a long random string. Email and Paystack are optional while testing.
4. Run `npm run dev`, then open http://localhost:3000

## How it works
- **Customers** sign up, browse restaurants, add food to a cart, check out with Card, bank transfer or cash, and track the order step by step.
- **Vendors** choose "I run a restaurant" at sign-up. Their dashboard has three tabs:
  - **Orders**: new orders appear automatically. Confirm transfer payments, then move each order through the stages.
  - **Menu**: add, edit, delete items, and switch an item off when it sells out.
  - **Settings**: restaurant details and the bank account shown to customers who pay by transfer.
- Passwords are hashed (scrypt). Login uses a signed, HttpOnly cookie.
- Prices live on the server. The browser only sends item ids and quantities, and the server works out the total.
- Data is stored in `data.json` (users, restaurants, menus, orders).

## Card payment (Paystack)
1. Create a free account at paystack.com and copy your **secret key** (starts with `sk_test_` while testing).
2. Put it in `.env` as `PAYSTACK_SECRET`, and set `BASE_URL` to your site's address.
3. Customers who pick Card are sent to Paystack's payment page. The server confirms the amount with Paystack before marking the order paid and sending emails. Card details never touch your server.
4. For real money, switch to your live key (`sk_live_`) after Paystack approves your business.

Money from card payments goes to the one Paystack account you configure. Paying each restaurant separately (Paystack subaccounts) is not built yet.

## Before going live
- Host it behind HTTPS (Render, Railway or a VPS) and set `BASE_URL` to the https address so cookies are marked Secure.
- Set a permanent `SESSION_SECRET`. Without it everyone is signed out on every restart.
- Keep `data.json` on a persistent disk and back it up. For many restaurants, move to a real database such as SQLite or Postgres.
- There is no password reset yet.
