const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST,
  port:   parseInt(process.env.EMAIL_PORT || '587'),
  secure: process.env.EMAIL_PORT === '465',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const FROM = process.env.EMAIL_FROM || 'QUID <no-reply@quid.co.uk>';
const BASE = process.env.BASE_URL   || 'http://localhost:3000';

// ── SHARED STYLES ─────────────────────────────────────────────────────────────
const css = `
  body { margin:0; padding:0; background:#07060f; font-family:'Helvetica Neue',Arial,sans-serif; color:#fff; }
  .wrap { max-width:560px; margin:0 auto; padding:40px 20px; }
  .logo { font-size:2.4rem; font-weight:700; letter-spacing:-0.04em;
          background:linear-gradient(135deg,#fff 20%,#b44eff 60%,#4f8bff 100%);
          -webkit-background-clip:text; -webkit-text-fill-color:transparent;
          background-clip:text; margin-bottom:8px; }
  .sub  { font-size:0.75rem; letter-spacing:0.18em; text-transform:uppercase;
          color:rgba(180,160,255,0.5); margin-bottom:36px; }
  .card { background:rgba(14,8,32,0.8); border:1px solid rgba(150,100,255,0.2);
          border-radius:20px; padding:32px; margin-bottom:24px; }
  .amount { font-size:3rem; font-weight:700; letter-spacing:-0.04em; color:#b44eff;
            text-shadow:0 0 24px rgba(180,78,255,0.5); }
  .label  { font-size:0.68rem; letter-spacing:0.2em; text-transform:uppercase;
            color:rgba(180,160,255,0.4); margin-bottom:6px; }
  .body-text { font-size:0.9rem; color:rgba(200,180,255,0.6); line-height:1.7; }
  .highlight { color:#fff; font-weight:600; }
  .pill { display:inline-block; background:rgba(130,60,255,0.2);
          border:1px solid rgba(150,100,255,0.3); border-radius:99px;
          padding:5px 14px; font-size:0.75rem; color:rgba(200,180,255,0.7);
          margin-bottom:24px; }
  .btn  { display:inline-block; background:linear-gradient(135deg,#7c3aed,#b44eff 60%,#4f8bff);
          color:#fff; text-decoration:none; border-radius:12px; padding:14px 28px;
          font-size:0.85rem; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;
          margin-top:8px; }
  .footer { font-size:0.65rem; color:rgba(180,160,255,0.2); letter-spacing:0.05em;
            text-align:center; margin-top:32px; line-height:1.8; }
  hr { border:none; border-top:1px solid rgba(130,80,255,0.15); margin:20px 0; }
`;

function html(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>${css}</style></head>
  <body><div class="wrap">
    <div class="logo">QUID</div>
    <div class="sub">£1 a week · one winner</div>
    ${body}
    <div class="footer">
      QUID · Free Prize Draw · 18+ UK residents only<br>
      <a href="${BASE}/unsubscribe" style="color:rgba(130,80,255,0.4);">Unsubscribe</a>
      &nbsp;·&nbsp;
      <a href="${BASE}" style="color:rgba(130,80,255,0.4);">quid.co.uk</a>
    </div>
  </div></body></html>`;
}

// ── EMAILS ────────────────────────────────────────────────────────────────────

async function sendWelcome(user, entriesThisWeek) {
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: `Welcome to QUID, ${user.name.split(' ')[0]}! 🎟`,
    html: html('Welcome to QUID', `
      <div class="card">
        <div class="label">You're in the pool</div>
        <div class="amount">${entriesThisWeek}</div>
        <div class="body-text" style="margin-top:4px;">entries this week</div>
        <hr>
        <p class="body-text">
          Hey <span class="highlight">${user.name.split(' ')[0]}</span> 👋<br><br>
          Your QUID subscription is live. You've been entered into this Monday's draw
          with <span class="highlight">${entriesThisWeek} entries</span>
          (4 monthly + 5 signup bonus — equal odds to every other entry).
        </p>
        <p class="body-text">
          The draw happens every <span class="highlight">Monday at 12:00 noon</span>.
          One random entry wins the entire pot. This week's pot:
          <span class="highlight">check the site for the live total</span>.
        </p>
      </div>
      <div class="pill">✉ Free postal entry also available — see T&Cs</div>
      <br>
      <a class="btn" href="${BASE}">View this week's pot →</a>
    `),
  });
}

async function sendWinnerNotification(user, potAmount, weekStart, totalEntries) {
  const fmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  const grossPot = Math.round(potAmount / 0.9 * 100) / 100;
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: `🏆 You won ${fmt.format(potAmount)} — QUID Draw ${weekStart}`,
    html: html('You Won!', `
      <div class="card">
        <div class="label">You won this week's pot</div>
        <div class="amount">${fmt.format(potAmount)}</div>
        <p class="body-text" style="margin-top:12px;">
          Congratulations <span class="highlight">${user.name.split(' ')[0]}</span>!<br><br>
          Your entry <span class="highlight">@${user.handle}</span> was selected at random
          from <span class="highlight">${totalEntries} entries</span> in the draw for
          week starting <span class="highlight">${weekStart}</span>.
        </p>
        <hr>
        <p class="body-text">
          Total pot: <span class="highlight">${fmt.format(grossPot)}</span><br>
          Platform fee (10%): <span class="highlight">${fmt.format(grossPot - potAmount)}</span><br>
          <strong style="color:#fff;">Your prize: ${fmt.format(potAmount)}</strong>
        </p>
        <hr>
        <p class="body-text">
          We'll transfer <span class="highlight">${fmt.format(potAmount)}</span> to your
          registered bank account within <span class="highlight">5 working days</span>.<br><br>
          Reply to this email with your bank details (sort code + account number) if we
          don't already have them on file.
        </p>
      </div>
      <a class="btn" href="${BASE}">View the draw results →</a>
    `),
  });
}

async function sendDrawResult(user, winnerHandle, potAmount, weekStart) {
  const fmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: `This week's QUID winner — ${fmt.format(potAmount)} won by @${winnerHandle}`,
    html: html('Weekly Draw Result', `
      <div class="card">
        <div class="label">Week of ${weekStart}</div>
        <div class="amount">${fmt.format(potAmount)}</div>
        <p class="body-text" style="margin-top:12px;">
          This week's winner is <span class="highlight">@${winnerHandle}</span> 🎉<br><br>
          Better luck next week — your subscription keeps you in the pool every Monday.
          The pot grows with every new member, so
          <span class="highlight">share QUID with friends</span> to make next week's prize bigger.
        </p>
      </div>
      <a class="btn" href="${BASE}">See next week's pot →</a>
    `),
  });
}

async function sendPaymentConfirmation(user, amountPence, periodStart) {
  const fmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: `QUID payment confirmed — ${fmt.format(amountPence / 100)}`,
    html: html('Payment Confirmed', `
      <div class="card">
        <div class="label">Monthly subscription</div>
        <div class="amount">${fmt.format(amountPence / 100)}</div>
        <p class="body-text" style="margin-top:12px;">
          Payment received for your QUID monthly subscription.<br>
          You have <span class="highlight">4 entries</span> across the next 4 weekly draws.
        </p>
        <hr>
        <p class="body-text">
          Period start: <span class="highlight">${periodStart}</span><br>
          Next charge: approximately 30 days from now.
        </p>
      </div>
      <a class="btn" href="${BASE}">View this week's pot →</a>
    `),
  });
}

async function sendPaymentFailed(user) {
  await transporter.sendMail({
    from: FROM,
    to:   user.email,
    subject: 'QUID — payment failed, action required',
    html: html('Payment Failed', `
      <div class="card">
        <p class="body-text">
          Hi <span class="highlight">${user.name.split(' ')[0]}</span>,<br><br>
          We couldn't process your monthly QUID subscription payment.
          Your entries will be paused until payment is resolved.<br><br>
          Please update your payment details via the link below.
        </p>
      </div>
      <a class="btn" href="${BASE}">Update payment details →</a>
    `),
  });
}

module.exports = {
  sendWelcome,
  sendWinnerNotification,
  sendDrawResult,
  sendPaymentConfirmation,
  sendPaymentFailed,
};
