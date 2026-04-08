const crypto = require('crypto');
const cron   = require('node-cron');
const { db, q, currentWeekStart, addWeeklyEntries } = require('./db');
const email  = require('./email');

/**
 * Run the weekly draw for the given weekStart date string.
 * If weekStart is omitted, uses the current week.
 * Returns the draw result or null if no entries.
 */
async function runDraw(weekStart) {
  weekStart = weekStart || currentWeekStart();

  // Prevent double-draw
  const existing = q.getDrawForWeek.get(weekStart);
  if (existing) {
    console.log(`[draw] Draw for ${weekStart} already completed.`);
    return existing;
  }

  const entries = q.getEntriesForWeek.all(weekStart);

  if (entries.length === 0) {
    console.log(`[draw] No entries for week ${weekStart} — draw skipped.`);
    return null;
  }

  // Cryptographically secure random index
  const winnerIdx   = crypto.randomInt(0, entries.length);
  const winnerEntry = entries[winnerIdx];

  // Pot = total entries × £1, winner receives 90% (10% platform fee)
  const grossPot  = entries.length;
  const potAmount = Math.floor(grossPot * 0.9 * 100) / 100;

  // Look up winner details
  const winnerUser   = winnerEntry.user_id ? q.getUserById.get(winnerEntry.user_id) : null;
  const winnerHandle = winnerUser ? winnerUser.handle : (winnerEntry.label || 'postal-entry');

  // Record the draw
  q.recordDraw.run({
    week_start:      weekStart,
    winner_entry_id: winnerEntry.id,
    winner_user_id:  winnerUser ? winnerUser.id : null,
    winner_handle:   winnerHandle,
    pot_amount:      potAmount,
    total_entries:   entries.length,
  });

  console.log(`[draw] ✅ Week ${weekStart} — winner: @${winnerHandle}, pot: £${potAmount}, entries: ${entries.length}`);

  // ── EMAILS ──────────────────────────────────────────────────────────────────
  try {
    // Notify the winner
    if (winnerUser) {
      await email.sendWinnerNotification(winnerUser, potAmount, weekStart, entries.length);
    }

    // Notify all other active subscribers of the result
    const allActive = q.getAllActiveUsers.all();
    for (const user of allActive) {
      if (winnerUser && user.id === winnerUser.id) continue; // winner already emailed
      try {
        await email.sendDrawResult(user, winnerHandle, potAmount, weekStart);
      } catch (e) {
        console.error(`[draw] Failed to email ${user.email}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[draw] Email error:', e.message);
  }

  return q.getDrawForWeek.get(weekStart);
}

/**
 * Add the next week's subscription entry for every active subscriber.
 * Called at the start of each new week (Monday) before the draw runs.
 */
function addWeeklyEntriesForAllActive(weekStart) {
  const users = q.getAllActiveUsers.all();
  for (const user of users) {
    addWeeklyEntries(user.id, weekStart);
  }
  console.log(`[draw] Added entries for ${users.length} active subscribers for week ${weekStart}`);
}

/**
 * Schedule: every Monday at 11:00 — seed this week's entries.
 *           every Monday at 12:00 — run the draw.
 * Cron syntax: minute hour day month weekday
 */
function startScheduler() {
  // 11:00 every Monday — add entries for all active subscribers
  cron.schedule('0 11 * * 1', () => {
    const week = currentWeekStart();
    console.log(`[cron] Seeding entries for week ${week}`);
    addWeeklyEntriesForAllActive(week);
  }, { timezone: 'Europe/London' });

  // 12:00 every Monday — run the draw
  cron.schedule('0 12 * * 1', async () => {
    const week = currentWeekStart();
    console.log(`[cron] Running draw for week ${week}`);
    await runDraw(week);
  }, { timezone: 'Europe/London' });

  console.log('[draw] Scheduler started — draws run every Monday at 12:00 London time');
}

module.exports = { runDraw, addWeeklyEntriesForAllActive, startScheduler };
