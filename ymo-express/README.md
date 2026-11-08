# Ymo Express

A food delivery marketplace, built like Fiverr: customers pay inside the app, the money is held until the food is delivered, then the vendor's wallet is credited minus our fee.

## Run it
1. Install Node.js 20 or newer, then run `npm install` in this folder.
2. Copy `.env.example` to `.env` and fill it in (at least `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `DEMO_PAYMENTS=1` for testing).
3. `npm run dev`, then open http://localhost:3000

## Accounts and approval
- **Age:** everyone must be 17 or older (date of birth is checked on the server).
- **Customers** and **vendors** create accounts with email + password or **Continue with Google**.
- **Vendors** must give their location, a Nigerian ID type (NIN, driver's licence, voter's card or international passport), the ID number and a photo of the card. The photo is stored in a private folder (`ID_DIR`) and only the admin can open it.
- New accounts are **pending**. Vendors only go live, and customers can only order, after the admin approves them. Set `CUSTOMER_APPROVAL=0` to approve customers automatically.
- **Admin:** sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The admin page has Overview (revenue, money held, owed), Approvals (see the ID card, approve or reject), All accounts (search, suspend, reactivate), Payouts and Orders.

## Money
- Customer pays: food + delivery + **5.5% service fee** (`SERVICE_FEE_PCT`).
- Vendor earns: food − **20% commission** (`COMMISSION_PCT`) + the full delivery fee.
- The vendor's money is released when the order is delivered and the customer taps "I got my food", or `HOLD_HOURS` after delivery.
- Vendors save a bank account in the **Wallet** tab and request a withdrawal. The admin sends the money by bank transfer, then taps "Mark as paid".
- Real payments use Paystack (`PAYSTACK_SECRET`). `DEMO_PAYMENTS=1` adds a fake pay button for testing only. Never use it with real customers.

## Locations
Every location is a dropdown: country, then state, then area (Nigeria uses the 774 official local government areas in `data/ng-lgas.json`; other countries use cities from the `country-state-city` package). Vendors choose where they are and add every place they deliver to (a whole country, a whole state, or one area). Customers can only order from vendors who deliver to their chosen place.

## Google sign-in setup
1. Google Cloud Console > APIs & Services > Credentials > Create credentials > OAuth client ID > Web application.
2. Add your site address (for example `https://yeye-moremi.onrender.com`, and `http://localhost:3000` for testing) under Authorized JavaScript origins.
3. Copy the Client ID into `GOOGLE_CLIENT_ID`.

## Keeping data safe (free)
Set `DATABASE_URL` to a free Neon Postgres connection string. Accounts, orders, wallets, menu photos and ID cards are then stored in the database and survive restarts. Without it the app uses `data.json` and folders, which Render's free plan wipes on every restart, so use that only on your own computer.

## Before real money
- Holding customers' money for vendors can need licences or a payment partner (for example Paystack split payments). Check with a lawyer or your payment provider.
- Collecting ID numbers means handling personal data. Keep `ID_DIR` private and follow Nigeria's data protection rules (NDPR).
- There is no password reset yet.

## Goods marketplace (Jumia-style)

- Sellers list any goods in 12 categories, with photo (required), price, old price (shows a discount), brand and stock count.
- Shoppers can add items from several sellers to one cart and pay once. Each seller gets its own order (delivery fee per seller).
- Stock is held when an order is placed. Unpaid orders release the stock after `RESERVE_MIN` minutes (default 120).

## Riders, distance pricing, sizes and colours

- **Riders** sign up like sellers (name, age 18+, vehicle, area, Nigerian ID card). The admin approves them. They then see a **Gigs** board of paid orders the seller has packed, take one (up to 3 at a time), pick it up, and deliver it. Sellers never deliver.
- **Delivery code:** the customer sees a 4-digit code on the order page. The rider must type it to finish the delivery, so nobody can mark an order delivered without handing it over.
- **Delivery price and time** come from the distance between the seller's area and the customer's area: `DELIVERY_BASE + km x DELIVERY_PER_KM` (default 500 + 40/km, rounded to 50, capped at `DELIVERY_MAX`). These are estimates by area (matching city or state centre, plus 35% for roads), not live GPS.
- **Who gets what:** seller = items minus `COMMISSION_PCT` (20%). Rider = delivery fee minus `RIDER_CUT_PCT` (10%). Ymo Express keeps the commission, the rider cut and the buyer service fee. All paid out manually from the admin Payouts tab.
- **Sizes and colours:** sellers add them to a product (stock is one number for all variants). Shoppers must choose before adding to the cart.
