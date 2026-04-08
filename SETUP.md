# QUID — Setup Guide

## 1. Install dependencies

```bash
cd "C:\Users\2face\OneDrive\Desktop\QUIS"
npm install
```

## 2. Create your .env file

Copy `.env.example` to `.env` and fill in the values:

```bash
copy .env.example .env
```

---

## 3. Stripe setup (15 minutes)

1. Go to **dashboard.stripe.com** and create an account (or log in)
2. Make sure you're in **Test mode** first (toggle top-left)

### Create the £4/month product:
- Products → Add product
- Name: "QUID Monthly Subscription"
- Price: £4.00, recurring, monthly
- Copy the **Price ID** (starts with `price_`) → paste into `.env` as `STRIPE_PRICE_ID`

### Get your API keys:
- Developers → API keys
- Copy **Secret key** → paste as `STRIPE_SECRET_KEY`

### Set up the webhook:
- Developers → Webhooks → Add endpoint
- URL: `https://your-domain.com/webhook`  
  *(For local testing use Stripe CLI: `stripe listen --forward-to localhost:3000/webhook`)*
- Events to listen for:
  - `checkout.session.completed`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `customer.subscription.deleted`
- Copy the **Signing secret** → paste as `STRIPE_WEBHOOK_SECRET`

---

## 4. Email setup

**Easiest option — Gmail App Password:**
1. Google Account → Security → 2-Step Verification (enable it)
2. Security → App Passwords → create one for "Mail"
3. Use your Gmail address as `EMAIL_USER`, the app password as `EMAIL_PASS`
4. `EMAIL_HOST=smtp.gmail.com`, `EMAIL_PORT=587`

**Or use Brevo/Resend/Mailgun** for higher volume — update HOST/PORT/USER/PASS accordingly.

---

## 5. Run the server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Server runs on http://localhost:3000

---

## 6. Test the full flow

```bash
# Install Stripe CLI (Windows — download from stripe.com/docs/stripe-cli)
# Then forward webhooks locally:
stripe listen --forward-to localhost:3000/webhook
```

1. Open http://localhost:3000
2. Click "Subscribe — £4/mo", fill in the form
3. Use Stripe test card: **4242 4242 4242 4242**, any future date, any CVC
4. Check your email for the welcome message
5. Check the database: a `quid.db` file will be created automatically

---

## 7. Admin endpoints

All require header `x-admin-key: <your ADMIN_KEY from .env>`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/run-draw` | Manually trigger the draw (body: `{"week":"2026-04-07"}`) |
| `POST` | `/admin/postal-entry` | Add a postal entry (body: `{"name":"John Smith","week":"2026-04-07"}`) |
| `GET`  | `/admin/users` | List all users |
| `POST` | `/admin/seed-entries` | Manually seed entries for current week |

---

## 8. Going live

1. Switch Stripe from Test → Live mode, get new keys
2. Deploy to a server (Railway, Render, DigitalOcean — all work well)
3. Set `BASE_URL` to your real domain
4. Point your domain DNS to the server
5. Update the Stripe webhook URL to your live domain

---

## Draw schedule

- **Every Monday 11:00 London time** — entries seeded for all active subscribers
- **Every Monday 12:00 London time** — draw runs, winner emailed, all members notified

The scheduler starts automatically when the server starts.
