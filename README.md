# Binance P2P Automation Bot — SAPI v7.4

Fully automated P2P buyer bot:
**New Order → Auto Chat → PAN Verify → TDS → Auto Payment → Confirm**

---

## Project Structure

```
p2p-bot/
├── src/
│   ├── index.js                    ← Entry point
│   ├── config/
│   │   └── config.js               ← All env vars + feature flags
│   ├── bot/
│   │   ├── orderPoller.js          ← Detect new orders + fallback chat poll
│   │   ├── orderHandler.js         ← Complete per-order flow
│   │   ├── stateManager.js         ← Order state machine
│   │   └── messages.js             ← All bot message templates
│   ├── services/
│   │   ├── binanceService.js       ← SAPI v7.4 API calls
│   │   ├── chatService.js          ← WebSocket chat (wss://im.binance.com)
│   │   ├── panService.js           ← PAN verify (Surepass)
│   │   └── paymentService.js       ← Razorpay payout
│   └── utils/
│       ├── logger.js               ← Winston logs
│       └── helpers.js              ← Signature, PAN, TDS, Telegram
├── .env.example
└── package.json
```

---

## Setup

```bash
# 1. Install
npm install

# 2. Create .env
cp .env.example .env

# 3. Fill only Binance keys (Phase 1)
# 4. Run
npm run dev
```

---

## Phase-wise Setup

### Phase 1 — Chat Only (Binance keys required)
```
BINANCE_API_KEY=...
BINANCE_SECRET_KEY=...
```
Bot will: detect orders → chat → ask PAN → verify format →
show TDS → wait for consent → alert YOU on Telegram → YOU pay manually.

### Phase 2 — Add PAN API (Surepass)
```
SUREPASS_TOKEN=...
```
Bot will: same as above but verify PAN via real govt database.

### Phase 3 — Full Auto (Add Razorpay)
```
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_ACCOUNT_NUMBER=...
```
Bot will: do everything automatically including payment. Zero manual work.

---

## How Chat Works (SAPI v7.4)

```
1. New order detected via POST /sapi/v1/c2c/orderMatch/listOrders
   (filtered: tradeType=BUY, status=1 "Wait for payment")

2. Bot calls GET /sapi/v1/c2c/chat/retrieveChatCredential?orderNo=...&clientType=web
   → Gets { chatWssUrl, listenKey, listenToken }

3. Bot connects WebSocket:
   wss://im.binance.com:443/chat/<listenKey>?token=<listenToken>&clientType=web

4. Incoming msgs are parsed; only { self: false } seller messages
   are routed to the state machine.

5. Bot SENDS messages JSON-over-WSS (with REST fallback to
   POST /sapi/v1/c2c/chat/sendMessage  body { orderNo, content, msgType:'text' })

6. If WSS drops → exponential-backoff reconnect (re-fetches credential)
   AND fallback REST polling kicks in.

7. Order status push (or 15s completion poll) detects status=4 (Completed)
   → bot sends configurable thank-you message.
```

## Configurable Messages (Req #1, #6)

Set in `.env` to override defaults:

```
WELCOME_MESSAGE=Thanks for choosing us, kindly enter your PAN card number
THANK_YOU_MESSAGE=🎉 Thanks for trading with us! {cryptoAmount} {asset} sent.
```

Placeholders: `{sellerName}`, `{amount}`, `{asset}`, `{cryptoAmount}`, `{orderNo}`

---

## Binance Merchant Account

Chat API (SAPI v7.4) requires Merchant status.

```
Apply: https://c2c.binance.com/en/merchantApplication

Requirements:
✅ 30+ completed P2P orders
✅ 90%+ completion rate
✅ KYC verified
✅ Active P2P advertisements
```

---

## Production Deploy (PM2)

```bash
npm install -g pm2
npm run pm2:start
npm run pm2:logs
```

---

## Telegram Setup (Optional but Recommended)

```
1. Message @BotFather on Telegram
2. /newbot → give name → get TOKEN
3. Start your bot → message it /start
4. Open: https://api.telegram.org/bot<TOKEN>/getUpdates
5. Find "chat": { "id": 123456789 } → that is your CHAT_ID
6. Add both to .env
```
