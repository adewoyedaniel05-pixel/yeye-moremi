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
- **Who gets what:** seller = items minus `COMMISSION_PCT` (20%). Rider = the full rider price (the customer pays that plus `ADMIN_DELIVERY_MARKUP`). Ymo Express keeps the commission, the delivery markup and the buyer service fee. All paid out manually from the admin Payouts tab.
- **Sizes and colours:** sellers add them to a product (stock is one number for all variants). Shoppers must choose before adding to the cart.

## Shopper accounts, returns, coupons, approvals
- **Forgot password:** "Forgot your password?" on the sign-in page. If email (SMTP) is not set up, the link is not emailed: open Admin → All accounts → "Password reset link", copy it and send it to the person (works 1 hour).
- **Wishlist, saved addresses, change password:** heart on any product, and the Account page.
- **Cancel:** a customer can cancel until a rider picks up the order (full refund). Sellers can reject an order they can't fulfil (also a full refund).
- **Returns:** within `RETURN_DAYS` after delivery. Admin → Refunds approves or rejects. Approved returns refund the item price (not delivery or service fee) and the seller does not earn on that order.
- **Refunds:** sent through Paystack automatically when payments are live. If one fails, Admin → Refunds has "Retry" and "I sent it by hand".
- **Coupons:** Admin → Coupons (percent or fixed, minimum spend, usage limit, expiry). One use per shopper. Ymo Express pays for the discount; sellers still earn their full share.
- **Product approval:** new or changed products (name, description, brand, category, photo) wait in Admin → Products. Set `PRODUCT_APPROVAL=0` to turn this off.
- **Seller Analytics tab:** sales chart, best sellers, low stock.
- **Shop filters:** price range, brand, "Most popular" sort.

## UptimeRobot health checks
- `/api/health` is a light check that the app is awake (use this for the 5-minute ping).
- `/api/health/database` also checks the database connection.
Add each as an HTTP(s) monitor in UptimeRobot with your Render address in front.
- Riders must register with a valid driver's licence (number and photo); the admin sees it on the rider's card.

## Screening bot (free)
Checks every sign-up by rules, with no outside service: minimum age, driver's licence for riders, an ID number already used on another account, a phone number already used, a normal Nigerian phone number, a real-looking name, and a very small ID photo.
- Customers that pass are approved automatically.
- Sellers and riders that pass are marked "looks good" and listed first for you. You still approve them (set `BOT_APPROVE_PROS=1` to let the bot approve them too).
- A duplicate ID number or under-age is rejected automatically, with the reason shown to the person. Anything odd is flagged for you.
- You can reverse any bot decision in Admin, and "Run bot check" re-checks an account. `BOT_AUTO=0` turns the bot off.
- This bot cannot tell if an ID is real or if the face matches. That needs a paid ID-check service such as Smile ID, Dojah or Prembly.

## Delivery pricing and drop-off points
- **Rider's price** = base + per-km (`DELIVERY_BASE`, `DELIVERY_PER_KM`). The rider collects all of it.
- **Customer pays** the rider's price + `ADMIN_DELIVERY_MARKUP` (₦500). Ymo Express keeps the markup. Example: rider's price ₦1,000, customer pays ₦1,500.
- **Drop-off points** (Admin → Drop-offs): add a town, a name and a landmark where customers collect orders (for example "Ile-Ife drop-off"). Customers can then choose "Collect at a drop-off point" at checkout. It costs the base price. "Door-to-door" adds `DOOR_EXTRA` (₦500), which goes to the rider. With no drop-off points added, delivery is door-to-door at the base price. The customer collects at the drop-off with the same 4-digit code.
- `RIDER_CUT_PCT` (default 0) lets Ymo Express keep an additional percentage of the rider's price.

## Messages and custom offers
- **Message seller:** button on every product page. Customers and sellers chat under **Messages** in the top menu, with an unread badge. Email alerts go out only if SMTP is set up.
- **Safety:** phone numbers, emails, links and "WhatsApp/Telegram" are blocked in chat, so deals and payments stay inside Ymo Express (and your commission is protected). Chats are private; admin cannot read them. Message rate is limited.
- **Custom offer (like Fiverr):** the seller taps "Create custom offer" in the chat: product, quantity, size/colour, a lower price per item (never above the listed price) and a note. It stays open 48 hours. The customer taps "Accept and pay", the item goes in the cart at the offer price, and checkout works as normal (delivery, service fee, coupon). The seller earns the usual 80% of the offer price.
- An offer can be used once. If the customer abandons payment, the offer opens again until it expires. The seller can withdraw an open offer.

## Legal pages, consent and chat safety bot
- Pages (linked in the footer): Terms of Service, Privacy Policy, Returns and Refunds, Cookies, Seller Agreement, Rider Agreement, Prohibited Items, About, Contact. They are drafts: have a Nigerian lawyer review them before launch. Update `TERMS_VERSION` and the date in the code when you change them.
- Fill in `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `BUSINESS_ADDRESS`, `BUSINESS_NAME` (and `BUSINESS_REG` if registered) in Render. The admin overview reminds you until they are set.
- Sign-up needs a tick box to agree to the Terms and Privacy Policy. The agreement date and version are saved on the account.
- A cookie notice shows once. The site only uses essential cookies and storage (sign-in, cart, location).
- **Chat safety bot:** blocks phone and bank-account numbers (also spelled out), emails, links, WhatsApp/Telegram and similar apps, and "deal outside" phrases. The message is never delivered. The sender gets a warning, and at `CHAT_STRIKES` (default 3) warnings the account is suspended automatically and emailed. Admin sees the warnings on the person's card and in Admin → Bot log, and can reinstate them with the Approve button.

## Security
- **Passwords** are hashed with scrypt and a random salt per account. Sessions use a signed, HttpOnly, SameSite cookie that is also `Secure` on https. Set `SESSION_SECRET` in Render.
- **HTTPS:** http is redirected to https, HSTS is on, and headers block framing and sniffing.
- **Login:** one message for any wrong email or password (it also never reveals Google accounts), same response time, 10 wrong tries per email per network and 40 per network, then 15 minutes lock.
- **Fake sign-ups:** a hidden trap field, a minimum form time, 15 sign-ups per network per hour, optional Cloudflare Turnstile, and email verification. Verification is only enforced when email (SMTP) is set up: until the email is confirmed a customer cannot check out or message sellers, and sellers/riders are flagged for the admin.
- Cloudflare Turnstile: create a free widget at dash.cloudflare.com → Turnstile, add your site address, then put the keys in `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`.


## Sending emails (verification + password reset)
Render's free plan blocks SMTP, so use Brevo (free, 300 emails/day) over its HTTP API:
1. Sign up at brevo.com -> Senders & IP -> add and verify a sender email.
2. SMTP & API -> API keys -> Generate a key.
3. In Render -> Environment add `BREVO_API_KEY` (the key) and `MAIL_FROM` (e.g. `Ymo Express <you@yourdomain.com>`, must be the verified sender). Save.
4. Sign up with a real email to test. Email verification only switches on once email is configured.
Tip: a sender on your own domain lands in inboxes far better than a Gmail address.
