require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { q, currentWeekStart, addWeeklyEntries, generateReferralCode } = require('./db');
const email    = require('./email');
const { runDraw, addWeeklyEntriesForAllActive, startScheduler } = require('./draw');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.use(cors());

// Raw body needed for Stripe webhook signature verification — must come BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));   // serve index.html + assets

// ── HELPERS ───────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/** Live stats for the dashboard */
app.get('/api/stats', (req, res) => {
  const week         = currentWeekStart();
  const memberCount  = q.memberCount.get().n;
  const entriesThisWeek = q.totalEntriesToday.get(week).n;
  const recentDraws  = q.getRecentDraws.all();

  res.json({
    potAmount:       entriesThisWeek,   // £1 per entry
    memberCount,
    weekStart:       week,
    recentWinners:   recentDraws,
  });
});

/** How many entries does a user have this week? */
app.get('/api/entries', (req, res) => {
  const { email: userEmail } = req.query;
  if (!userEmail) return res.json({ entries: 0 });

  const user = q.getUserByEmail.get(userEmail);
  if (!user || !user.is_active) return res.json({ entries: 0, active: false });

  const week    = currentWeekStart();
  const entries = q.countUserEntriesThisWeek.get(user.id, week).n;
  res.json({ entries, active: true, handle: user.handle });
});

/**
 * Create a Stripe Checkout session.
 * Frontend sends: { name, email, handle }
 * Returns: { url } — redirect to Stripe-hosted checkout page.
 */
/** Get a user's referral code by email */
app.get('/api/referral', (req, res) => {
  const { email: userEmail } = req.query;
  if (!userEmail) return res.status(400).json({ error: 'email required' });
  const user = q.getUserByEmail.get(userEmail);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ code: user.referral_code, handle: user.handle });
});

/** Validate a referral code (for the popup) */
app.get('/api/referral/validate', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });
  const user = q.getUserByReferralCode.get(code.toUpperCase());
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ handle: user.handle });
});

app.post('/api/checkout', async (req, res) => {
  const { name, email: userEmail, handle, ref } = req.body;

  if (!name || !userEmail || !handle) {
    return res.status(400).json({ error: 'name, email and handle are required' });
  }

  // Validate handle (alphanumeric + underscore, max 20 chars)
  if (!/^@?[a-zA-Z0-9_]{2,20}$/.test(handle)) {
    return res.status(400).json({ error: 'Invalid handle — letters, numbers and underscores only (2–20 chars)' });
  }

  const cleanHandle = handle.replace(/^@/, '');

  try {
    // Create or retrieve Stripe customer
    let customer;
    const existingUser = q.getUserByEmail.get(userEmail);

    if (existingUser?.stripe_customer_id) {
      customer = await stripe.customers.retrieve(existingUser.stripe_customer_id);
    } else {
      customer = await stripe.customers.create({
        name,
        email: userEmail,
        metadata: { handle: cleanHandle },
      });

      // Pre-create user record (is_active=0 until payment confirmed)
      try {
        // Look up referrer
        const referrer = ref ? q.getUserByReferralCode.get(ref.toUpperCase()) : null;
        // Referred users get 5 signup bonus + 3 referral bonus = 8 bonus entries
        q.createUser.run({
          name,
          email:              userEmail,
          handle:             cleanHandle,
          stripe_customer_id: customer.id,
          bonus_remaining:    referrer ? 8 : 5,
          referral_code:      generateReferralCode(),
          referred_by:        referrer ? referrer.id : null,
        });
      } catch (e) {
        return res.status(409).json({ error: 'That email or username is already registered' });
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customer.id,
      mode:       'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.BASE_URL}/?cancelled=1`,
      subscription_data: {
        metadata: { handle: cleanHandle, ref: ref || '' },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[webhook] ${event.type}`);

  switch (event.type) {

    case 'checkout.session.completed': {
      const session  = event.data.object;
      const custId   = session.customer;
      const subId    = session.subscription;
      const user     = q.getUserByCustomer.get(custId);
      if (!user) break;

      // Activate the account
      q.activateUser.run({ sub_id: subId, cust_id: custId });

      // Add this week's entries (subscription + 5 bonus tickets)
      const week = currentWeekStart();
      addWeeklyEntries(user.id, week);

      // Credit referrer with 2 bonus entries
      const freshUser = q.getUserByCustomer.get(custId);
      if (freshUser.referred_by) {
        const referrer = q.getUserById.get(freshUser.referred_by);
        if (referrer) {
          q.addBonusEntries.run({ n: 2, id: referrer.id });
          console.log(`[webhook] Credited @${referrer.handle} with 2 bonus entries for referring @${user.handle}`);
          try { await email.sendReferralBonus(referrer, freshUser.handle); } catch(e) { console.error(e.message); }
        }
      }

      const entryCount = q.countUserEntriesThisWeek.get(user.id, week).n;
      console.log(`[webhook] Activated @${user.handle} — ${entryCount} entries for week ${week}`);

      // Welcome email
      try { await email.sendWelcome(freshUser, entryCount); } catch (e) { console.error(e.message); }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      // Skip the first invoice — that's handled by checkout.session.completed
      if (invoice.billing_reason === 'subscription_create') break;

      const custId  = invoice.customer;
      const user    = q.getUserByCustomer.get(custId);
      if (!user) break;

      // Ensure still active
      q.activateUser.run({ sub_id: invoice.subscription, cust_id: custId });

      // Record payment
      q.recordPayment.run({
        user_id:           user.id,
        stripe_invoice_id: invoice.id,
        stripe_payment_id: invoice.payment_intent,
        amount_pence:      invoice.amount_paid,
        status:            'succeeded',
      });

      // Add next week's entry (bonus already burned in first month)
      const week = currentWeekStart();
      addWeeklyEntries(user.id, week);

      console.log(`[webhook] Renewal payment for @${user.handle}`);

      try {
        await email.sendPaymentConfirmation(user, invoice.amount_paid, new Date().toISOString().slice(0,10));
      } catch (e) { console.error(e.message); }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const user    = q.getUserByCustomer.get(invoice.customer);
      if (!user) break;

      q.recordPayment.run({
        user_id:           user.id,
        stripe_invoice_id: invoice.id,
        stripe_payment_id: invoice.payment_intent,
        amount_pence:      invoice.amount_due,
        status:            'failed',
      });

      console.log(`[webhook] Payment FAILED for @${user.handle}`);
      try { await email.sendPaymentFailed(user); } catch (e) { console.error(e.message); }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub  = event.data.object;
      const user = q.getUserByCustomer.get(sub.customer);
      if (!user) break;
      q.deactivateUser.run({ cust_id: sub.customer });
      console.log(`[webhook] Subscription cancelled for @${user.handle}`);
      break;
    }
  }

  res.json({ received: true });
});

// ── ADMIN ENDPOINTS ───────────────────────────────────────────────────────────

/** Manually trigger a draw (for testing) */
app.post('/admin/run-draw', requireAdmin, async (req, res) => {
  const { week } = req.body;
  try {
    const result = await runDraw(week);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Add a postal entry */
app.post('/admin/postal-entry', requireAdmin, (req, res) => {
  const { name, week } = req.body;
  const { q: db } = require('./db');
  const weekStart = week || currentWeekStart();
  q.addEntry.run({ user_id: null, week_start: weekStart, entry_type: 'postal', label: name });
  res.json({ ok: true, weekStart });
});

/** View all users */
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = require('./db').db.prepare('SELECT id,name,email,handle,is_active,joined_at,bonus_remaining FROM users ORDER BY joined_at DESC').all();
  res.json(users);
});

/** Last draw with winner email */
app.get('/admin/last-draw', requireAdmin, (req, res) => {
  const draw = require('./db').db.prepare(`
    SELECT d.*, u.email as winner_email
    FROM draws d LEFT JOIN users u ON u.id = d.winner_user_id
    ORDER BY d.week_start DESC LIMIT 1
  `).get();
  res.json(draw || {});
});

/** Manually activate a user (webhook recovery) */
app.post('/admin/activate-user', requireAdmin, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  require('./db').db.prepare('UPDATE users SET is_active=1 WHERE id=?').run(user_id);
  res.json({ ok: true });
});

/** Seed entries for all active users for current week (manual fallback) */
app.post('/admin/seed-entries', requireAdmin, (req, res) => {
  const week = currentWeekStart();
  addWeeklyEntriesForAllActive(week);
  res.json({ ok: true, week });
});

// ── START ─────────────────────────────────────────────────────────────────────

startScheduler();

app.listen(PORT, () => {
  console.log(`\n🎰 QUID server running on http://localhost:${PORT}`);
  console.log(`   Stripe webhook endpoint: POST /webhook`);
  console.log(`   Draw schedule: every Monday 11:00 (seed) & 12:00 (draw) London time\n`);
});
