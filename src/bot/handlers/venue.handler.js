/**
 * Venue selection: the SELECT_VENUE step of the booking flow, plus the
 * /venue command to view or change the active venue at any time (the
 * "settings/profile" surface the spec asks for — this bot has no broader
 * profile screen, so /venue stands alone as that entry point).
 *
 * The chosen venue is deliberately NOT threaded through callback_data — a
 * venue_id (UUID, 36 chars) alongside a date and an activity/event id (also
 * UUIDs) would blow past Telegram's 64-byte callback_data limit. Instead the
 * choice is persisted per-user in storage (storage.service getUserVenue /
 * setUserVenue) and every downstream step (schedule.handler,
 * booking.handler) re-reads it fresh. Bonus: changing venue via /venue
 * mid-browse takes effect on the very next tap, with no stale venue baked
 * into an old inline keyboard.
 */

import { Markup } from 'telegraf';
import * as venueService from '../../services/venue.service.js';
import * as scheduleService from '../../services/schedule.service.js';
import * as storage from '../../services/storage.service.js';
import { getSession, setSession, clearSession } from '../session.js';
import { fitLabel } from '../../utils/text.js';
import * as logger from '../../utils/logger.js';

/** One row per venue. */
function buildVenueKeyboard(venues) {
  const rows = venues.map(v => [
    Markup.button.callback(fitLabel({ before: '📍 ', name: v.name }), `sv:${v.id}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** Renders the venue picker. Shared by the SELECT_VENUE gate and /venue's "change" button. */
async function sendVenuePicker(ctx, { edit = false, intro = '📍 Выбери площадку:' } = {}) {
  let venues;
  try {
    venues = await venueService.getVenues();
  } catch (err) {
    logger.error('bot', 'Failed to load venues', { error: err.message });
    const text = '⚠️ Не удалось загрузить список площадок. Попробуй ещё раз чуть позже.';
    if (edit) await ctx.editMessageText(text);
    else await ctx.reply(text);
    return;
  }

  const keyboard = buildVenueKeyboard(venues);
  if (edit) await ctx.editMessageText(intro, keyboard);
  else await ctx.reply(intro, keyboard);
}

/**
 * Gate for any flow that needs an active venue (Step 1 of /book /schedule).
 * Returns the venue id if the user already has one saved. Otherwise starts
 * the SELECT_VENUE step — shows the picker, remembers `resume` so the sv:
 * handler below knows what to continue into once a choice is made — and
 * returns null so the caller can stop handling this update.
 */
export async function ensureActiveVenue(ctx, { resume = null } = {}) {
  const active = await storage.getUserVenue(ctx.chat.id);
  if (active) return active.id;

  setSession(ctx.chat.id, { step: 'SELECT_VENUE', resume });
  await sendVenuePicker(ctx, { intro: '📍 Сначала выбери площадку, где будешь заниматься:' });
  return null;
}

/** The /venue "settings" view: current venue + a button to change it. */
async function renderVenueSettings(ctx) {
  const active = await storage.getUserVenue(ctx.chat.id);
  const text = active
    ? `📍 Текущая площадка: <b>${active.name}</b>`
    : '📍 Площадка ещё не выбрана.';

  await ctx.replyWithHTML(text, Markup.inlineKeyboard([
    [Markup.button.callback('🔁 Сменить площадку', 'venue:change')],
  ]));
}

export function registerVenueHandlers(bot) {
  bot.command('venue', async ctx => {
    try {
      await renderVenueSettings(ctx);
    } catch (err) {
      logger.error('bot', '/venue error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });

  bot.action('venue:change', async ctx => {
    try {
      await ctx.answerCbQuery();
      setSession(ctx.chat.id, { step: 'SELECT_VENUE', resume: null });
      await sendVenuePicker(ctx, { edit: true });
    } catch (err) {
      logger.error('bot', 'venue:change error', { error: err.message });
    }
  });

  // Selecting a venue — either as the SELECT_VENUE step of /schedule|/book,
  // or standalone via /venue → "🔁 Сменить площадку".
  bot.action(/^sv:([0-9a-fA-F-]{36})$/, async ctx => {
    const venueId = ctx.match[1];
    const chatId = ctx.chat.id;

    try {
      const venue = await venueService.getVenueById(venueId);
      if (!venue) {
        await ctx.answerCbQuery('Эта площадка больше не доступна. Попробуй ещё раз.', { show_alert: true });
        return;
      }

      await storage.setUserVenue(chatId, { id: venue.id, name: venue.name });

      const session = getSession(chatId);
      const resume = session?.step === 'SELECT_VENUE' ? session.resume : null;
      clearSession(chatId);

      logger.info('bot', `Active venue set for ${chatId}: ${venue.id} (${venue.name})`);
      await ctx.answerCbQuery(`Площадка выбрана: ${venue.name}`);

      if (resume === 'schedule') {
        // Step 3: proceed straight into the existing date/time/slot flow —
        // schedule.service owns this screen so both this handler and
        // schedule.handler's own /schedule entry point render it identically.
        const { text, keyboard } = scheduleService.buildDatePickerMessage();
        await ctx.editMessageText(`✅ Площадка: <b>${venue.name}</b>\n\n${text}`, { parse_mode: 'HTML', ...keyboard });
      } else if (resume === 'welcome') {
        // New-subscriber onboarding (see subscription.handler's /start) —
        // point them at the next step instead of leaving them at a dead end.
        await ctx.editMessageText(
          `✅ Площадка выбрана: <b>${venue.name}</b>\n\nОтправь /schedule, чтобы посмотреть расписание и записаться.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.editMessageText(`✅ Активная площадка: <b>${venue.name}</b>`, { parse_mode: 'HTML' });
      }
    } catch (err) {
      logger.error('bot', 'venue select error', { error: err.message });
      await ctx.answerCbQuery('Произошла ошибка. Попробуй снова позже.', { show_alert: true });
    }
  });
}
