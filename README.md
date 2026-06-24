# 🏃 Sport Bot

A Telegram bot that monitors the free Saturday workout schedule at **Park 50th Anniversary of V. October** (Minsk) and notifies subscribers as soon as the schedule appears or is updated.

---

## Features

- Automatically targets the upcoming Saturday's date
- Notifies on new schedule publication and on event count changes
- Shows available slots and waitlist status per activity
- Max 2 notifications per date to prevent spam
- Alerts the admin if the API fails 5 times in a row
- Subscribe / unsubscribe via Telegram commands

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
```

- **BOT_TOKEN** — create a bot and get the token from [@BotFather](https://t.me/BotFather)
- **ADMIN_CHAT_ID** — your personal Telegram chat ID; find it via [@userinfobot](https://t.me/userinfobot)

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
| `/start` | Subscribe to notifications |
| `/stop` | Unsubscribe from notifications |

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
├── bot.js          # All bot logic — polling, notifications, commands
├── db.json         # Persistent store for subscribers and schedule state
├── package.json
├── .env            # Environment variables (do not commit!)
└── .env.example    # Environment variables template
```

---

## Requirements

- Node.js **18** or higher
- Internet access for Telegram API and the schedule API
