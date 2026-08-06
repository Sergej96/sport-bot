# 🏃 Sport Bot

A Telegram bot that monitors the free Saturday workout schedule at **Park 50th Anniversary of V. October** (Minsk), notifies subscribers as soon as the schedule appears or is updated, and — once you log in with your спортдлявсех.бел account — can book slots and auto-retry full ones for you.

---

## Features

- Automatically targets the upcoming Saturday's date
- Notifies on new schedule publication and on event count changes
- Shows available slots and waitlist status per activity
- Max 2 notifications per date to prevent spam
- Alerts the admin if the API fails 5 times in a row
- Subscribe / unsubscribe via Telegram commands
- Log in with your спортдлявсех.бел account to book directly from the chat
- Full events can be added to an auto-booking waitlist — a background watcher retries every 60 seconds and notifies you the moment a slot is secured
- Pre-configure weekend auto-subscriptions (day + activity + time slot) via `/my_subscriptions` — the moment a matching event appears in a freshly-polled Saturday/Sunday schedule, the bot books it automatically, falling back to the waitlist queue if it's already full

---

## Quick Start

### 1. Clone the repository

```bash
git clone <repo-url>
cd sport-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the `.env` file

```bash
cp .env.example .env
cp db.example.json db.json
```

Open `.env` and fill in the values:

```env
BOT_TOKEN=your_telegram_bot_token_here
ADMIN_CHAT_ID=your_telegram_chat_id_here
ENCRYPTION_KEY=
```

- **BOT_TOKEN** — create a bot and get the token from [@BotFather](https://t.me/BotFather)
- **ADMIN_CHAT_ID** — your personal Telegram chat ID; find it via [@userinfobot](https://t.me/userinfobot)
- **ENCRYPTION_KEY** — only needed once someone runs `/login`; generate one with `openssl rand -hex 32`

### 4. Start the bot

```bash
# Production
npm start

# Development — auto-restarts on file changes (Node.js 18+)
npm run dev
```

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Subscribe to schedule notifications |
| `/stop` | Unsubscribe from notifications |
| `/schedule` | Browse the schedule and book / waitlist events |
| `/login` | Log in with your спортдлявсех.бел account (email + password, asked as chat messages) |
| `/logout` | Forget your stored session |
| `/my_bookings` | View and cancel your active bookings / waitlist items |
| `/my_subscriptions` | Manage weekend auto-booking presets (⚙️ Мои подписки) |

An **Unsubscribe** inline button is also shown in the welcome message.

---

## Notification Example

```
🔔 New workout schedule for July 5, 2026!

Nordic Walking:
  🟢 16:00:00 – 16:50:00 (slots: 8)
  🟢 17:00:00 – 17:50:00 (slots: 4)
  🔴 18:00:00 – 18:50:00 (waitlist)

Workout:
  🟢 10:00:00 – 10:50:00 (slots: 1)
  🔴 18:00:00 – 18:50:00 (waitlist)

Total events: 45
```

---

## Project Structure

```
sport-bot/
├── bot.js                          # Entrypoint — wiring, launch, shutdown
├── src/
│   ├── config.js                   # Env vars + constants
│   ├── utils/
│   │   ├── dates.js                 # Date/weekday helpers
│   │   ├── crypto.js                # AES-256-GCM encrypt/decrypt for stored passwords
│   │   └── logger.js                # Console wrapper that redacts secrets
│   ├── services/
│   │   ├── storage.service.js       # Atomic JSON read/write + accessors
│   │   ├── api.service.js           # Axios instance + error normalization
│   │   ├── auth.service.js          # Login, token refresh, re-login fallback
│   │   ├── booking.service.js       # Book event / waitlist queue / queue processing
│   │   ├── schedule.service.js      # Schedule fetch + message builders
│   │   └── watcher.service.js       # 60s schedule poll + 60s auto-booking watcher
│   └── bot/
│       ├── index.js                 # Telegraf instance + handler wiring
│       ├── session.js               # In-memory /login dialogue state
│       └── handlers/
│           ├── auth.handler.js
│           ├── subscription.handler.js
│           ├── schedule.handler.js
│           ├── booking.handler.js
│           ├── mybookings.handler.js
│           └── subscription-preset.handler.js
├── db.json                          # Persistent store (subscribers, schedule state, sessions, waitlist)
├── package.json
├── .env                             # Environment variables (do not commit!)
└── .env.example                     # Environment variables template
```

---

## Requirements

- Node.js **18** or higher
- Internet access for Telegram API and the schedule/booking API
