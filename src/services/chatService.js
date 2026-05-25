const WebSocket = require('ws');
const { config }              = require('../config/config');
const { uuidv4 }              = require('../utils/helpers');
const { getChatCredential }   = require('./binanceService');
const botStatusService        = require('./botStatusService');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Chat Service — single shared WebSocket per BOT (not per order)
//
//  Discovery: Binance C2C IM listenKey is per-USER. All orders' chat messages
//  arrive on the SAME WSS. Multiple per-order connections to the same
//  listenKey path conflict → all but one get kicked with "Bye". Token is
//  single-use; refetch credential on every fresh connect.
//
//  URL: wss://im.binance.com:443/chat/<listenKey>?token=<listenToken>&clientType=web
//
//  Public API:
//    register(orderNo, handler)   — subscribe to messages for an order
//    unregister(orderNo)          — remove subscription
//    sendMessage(orderNo, text)   — send via shared WSS (queued if not open)
//    ensureConnected(seedOrderNo) — fetch credential and connect if not already
//    disconnectAll()              — full shutdown
// ─────────────────────────────────────────────────────────────────────────────

class ChatService {
  constructor() {
    this.ws                = null;
    this.credential        = null;
    this.connecting        = false;
    this.handlers          = {};   // orderNo -> callback({ type, content, msgId, raw })
    this.sendQueues        = {};   // orderNo -> [text, ...] pending sends
    this.heartbeatTimer    = null;
    this.reconnectTimer    = null;
    this.reconnectAttempts = 0;
    this.openedAt          = null;
    this._firstFrameLogged = false;
    // Inbound-frame dedup. Binance occasionally pushes the same seller
    // message twice via WSS, and the fallback REST poller can race with
    // WSS too. Tracking the last N msgIds per order prevents the handler
    // from firing more than once for the same message.
    this._seenInboundIds   = {};   // orderNo -> { ids: Set, order: [] }
    this._SEEN_CAP_PER_ORDER = 200;
    // ── Background mode (real-time new-order detection) ──
    // When enabled, the WSS stays open even with zero registered handlers,
    // and any frame for an unhandled orderNo invokes _newOrderCallback so
    // the bot can pick up new orders the moment they arrive instead of
    // waiting for the next REST poll cycle.
    this._backgroundMode    = false;
    this._newOrderCallback  = null;
    this._seenNewOrders     = new Set();    // orderNos already signalled
    this._SEEN_NEW_ORDER_CAP = 500;
    this._credentialRefreshTimer = null;
  }

  // Returns true if the message was already handled and should be skipped.
  _alreadySeen(orderNo, msgId) {
    if (!orderNo || !msgId) return false;
    let entry = this._seenInboundIds[orderNo];
    if (!entry) {
      entry = this._seenInboundIds[orderNo] = { ids: new Set(), order: [] };
    }
    if (entry.ids.has(msgId)) return true;
    entry.ids.add(msgId);
    entry.order.push(msgId);
    // Bounded sliding window — evict oldest when over cap
    if (entry.order.length > this._SEEN_CAP_PER_ORDER) {
      const evict = entry.order.shift();
      entry.ids.delete(evict);
    }
    return false;
  }

  // ── Register a per-order message handler ──────────────────────────────────
  register(orderNo, handler) {
    this.handlers[orderNo] = handler;
    logger.info('Chat handler registered', { orderNo, totalHandlers: Object.keys(this.handlers).length });
    // If WSS is open, flush any queued outbound messages for this order
    this._flushSendQueue(orderNo);
  }

  unregister(orderNo) {
    if (!this.handlers[orderNo]) return;
    delete this.handlers[orderNo];
    delete this.sendQueues[orderNo];
    logger.info('Chat handler unregistered', { orderNo, totalHandlers: Object.keys(this.handlers).length });
  }

  // ── Ensure single shared WSS is connected. Fetches credential lazily. ─────
  async ensureConnected(seedOrderNo) {
    if (this._wssBanned) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return;
    if (!seedOrderNo) {
      seedOrderNo = Object.keys(this.handlers)[0];
    }
    // In background mode the WSS must come up even before any order has been
    // registered — that's the whole point of real-time new-order detection.
    // getChatCredential ignores the orderNo parameter (listenKey is per-USER)
    // so any non-empty string works as a seed.
    if (!seedOrderNo && this._backgroundMode) {
      seedOrderNo = '_bootstrap_';
    }
    if (!seedOrderNo) {
      logger.warn('ensureConnected called with no seed orderNo and no handlers');
      return;
    }

    this.connecting = true;
    try {
      // Always fetch FRESH credential — token is single-use
      this.credential = await getChatCredential(seedOrderNo);

      const wssUrl = this._buildWssUrl(this.credential);
      logger.info('Opening shared chat WSS');

      const ws = new WebSocket(wssUrl);
      this.ws = ws;
      this._firstFrameLogged = false;

      ws.on('open', () => {
        this.openedAt          = Date.now();
        this.reconnectAttempts = 0;
        logger.info('Chat WSS connected (shared)');

        // App-level keepalive
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try { ws.ping(); } catch (e) {}
        }, 30_000);

        // Flush queued outbound for ALL orders
        Object.keys(this.sendQueues).forEach(orderNo => this._flushSendQueue(orderNo));
      });

      ws.on('message', (rawData) => {
        const raw = rawData.toString();
        if (!this._firstFrameLogged) {
          this._firstFrameLogged = true;
          logger.info('WSS first frame received', { preview: raw.substring(0, 250) });
        }
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (err) { logger.error('WSS parse error', { error: err.message }); return; }
        this._dispatchFrame(parsed);
      });

      ws.on('error', (err) => {
        logger.error('Chat WSS error', { error: err.message });
      });

      ws.on('close', (code, reason) => {
        const lifeMs = this.openedAt ? Date.now() - this.openedAt : null;
        this.openedAt = null;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.ws = null;
        logger.warn('Chat WSS closed', {
          code,
          reason: reason?.toString().substring(0, 80),
          lifeMs,
        });
        this._scheduleReconnect();
      });
    } catch (err) {
      logger.error('Failed to open chat WSS', { error: err.message });
      this._scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  _buildWssUrl(credential) {
    const { chatWssUrl, listenKey, listenToken } = credential;
    if (chatWssUrl && chatWssUrl.includes('?')) return chatWssUrl;
    if (chatWssUrl && listenKey && chatWssUrl.includes(listenKey)) {
      return `${chatWssUrl}?token=${listenToken}&clientType=web`;
    }
    if (chatWssUrl) {
      const base = chatWssUrl.replace(/\/+$/, '');
      return `${base}/${listenKey}?token=${listenToken}&clientType=web`;
    }
    return `${config.binance.chatWssBase}/chat/${listenKey}?token=${listenToken}&clientType=web`;
  }

  // ── Dispatch incoming frame to the matching order's handler ───────────────
  _dispatchFrame(data) {
    if (!data) return;

    if (data.type === 'error' && data.content === 'ILLEGAL_PARAM') {
      logger.error('\n' +
        '❌ ══════════════════════════════════════════════════════════════ ❌\n' +
        '    Binance Chat WebSocket returned "ILLEGAL_PARAM".\n' +
        '    This usually means your API key lacks "Merchant" permissions,\n' +
        '    or Binance has restricted the P2P Chat WSS endpoint.\n' +
        '    The bot will gracefully stop WSS to prevent log spam.\n' +
        '    Please check your API key permissions and Merchant status.\n' +
        '❌ ══════════════════════════════════════════════════════════════ ❌\n'
      );
      this._wssBanned = true;
      this.disconnectAll();
      return;
    }

    // Other server-side errors (e.g. content filter rejections) — log loudly so
    // we can spot which outbound message Binance dropped. Correlate by uuid
    // back to the exact outbound text we sent (kept in this._sentTexts).
    if (data.type === 'error') {
      const original = data.uuid && this._sentTexts?.get(data.uuid);
      logger.error('Binance returned ERROR frame — outbound message was REJECTED', {
        binanceErrorContent: String(data.content || '').substring(0, 200),
        rejectedUuid:        data.uuid,
        topicId:             data.topicId,
        orderNo:             data.orderNo || original?.orderNo,
        rejectedTextFull:    original?.text || '(uuid not found in sent cache)',
        rejectedTextLength:  original?.text ? original.text.length : 0,
        sentAt:              original?.sentAt ? new Date(original.sentAt).toISOString() : null,
        rawFrame:            JSON.stringify(data).substring(0, 500),
      });
      // Don't ban WSS for these — just log. Sender keeps retrying with different text.
      return;
    }

    // Server "ping" — respond with pong
    if (data.type === 'ping' || data.type === 'PING') {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
      }
      return;
    }

    // Skip echoes of our own sent messages (Binance echoes back via WS)
    if (data.uuid && this._sentUuids?.has(data.uuid)) {
      this._sentUuids.delete(data.uuid);
      return;
    }

    // Pull orderNo — Binance WS uses `topicId` for order number.
    let orderNo = data.orderNo || data.topicId || data.adOrderNo || data.orderNumber;
    let innerJson = null;
    if (!orderNo && typeof data.content === 'string' && data.content.startsWith('{')) {
      try { innerJson = JSON.parse(data.content); orderNo = innerJson.orderNo || innerJson.topicId; }
      catch (e) {}
    }

    if (!orderNo) {
      // No orderNo — log and ignore (could be account-wide event)
      logger.debug('WSS frame without orderNo', { type: data.type, content: String(data.content || '').substring(0, 80) });
      return;
    }

    const handler = this.handlers[orderNo];
    if (!handler) {
      // No handler yet — this could be a NEW order arriving in real time.
      // Signal the new-order callback (registered by orderPoller). The
      // callback fetches the order detail, validates it's WAIT_PAYMENT, and
      // kicks off orderHandler.start() — bypassing the REST poll lag.
      //
      // Deduped by orderNo so a noisy seller (multiple chats / status pushes
      // for the same order) doesn't trigger the callback repeatedly. The
      // orderHandler.start() guard catches the race too, but checking here
      // avoids the redundant REST round-trip.
      if (this._newOrderCallback && !this._seenNewOrders.has(orderNo)) {
        this._seenNewOrders.add(orderNo);
        if (this._seenNewOrders.size > this._SEEN_NEW_ORDER_CAP) {
          const first = this._seenNewOrders.values().next().value;
          this._seenNewOrders.delete(first);
        }
        logger.info('WSS frame for unknown order — signalling new-order callback', {
          orderNo, type: data.type,
        });
        Promise.resolve(this._newOrderCallback(orderNo, data)).catch((err) => {
          logger.error('New-order callback threw', {
            orderNo, error: err.message,
          });
        });
      } else {
        logger.debug('WSS frame for unhandled order', { orderNo, type: data.type });
      }
      return;
    }

    // Order_status push
    if (data.type === 'order_status' || data.type === 'ORDER_STATUS') {
      const status = data.orderStatus ?? data.status;
      handler({ type: 'order_status', orderStatus: status, raw: data });
      return;
    }

    // System events — JSON-stringified inside content
    if (data.type === 'system' || data.type === 'SYSTEM') {
      const ev = String((innerJson && innerJson.type) || '').toLowerCase();
      logger.info('System event via WSS', { orderNo, ev });
      let mappedStatus;
      if (ev === 'buyer_completed' || ev === 'seller_released' || ev === 'order_completed') mappedStatus = 4;
      else if (ev === 'order_cancelled' || ev === 'buyer_cancelled' || ev === 'seller_cancelled') mappedStatus = 6;
      if (mappedStatus != null) {
        handler({ type: 'order_status', orderStatus: mappedStatus, raw: data });
      }
      return;
    }

    // STRICT: only process messages explicitly from the OTHER party (seller).
    //   self === true   → from buyer account (bot or admin in Binance UI) → skip
    //   self === false  → from seller (counterparty)                       → process
    //   missing/null    → unknown origin → SKIP for safety (don't auto-reply)
    if (data.self !== false) return;

    const type = String(data.type || data.msgType || 'text').toLowerCase();
    const msgId = data.uuid || data.msgId || data.id || `${Date.now()}`;

    if (type === 'text' || type === 'auto_reply') {
      const content = data.content || data.message || data.msg || '';
      const senderId = data.sendUserId || data.senderId || data.userId || '';
      if (!content) return;
      if (this._alreadySeen(orderNo, msgId)) {
        logger.debug('Duplicate inbound WSS frame — skipping', { orderNo, msgId });
        return;
      }
      logger.info('WSS text from seller', { orderNo, msgId, preview: String(content).substring(0, 60) });
      handler({ type: 'text', content, msgId, senderId, raw: data });
      return;
    }

    if (type === 'image' || type === 'video' || type === 'file') {
      if (this._alreadySeen(orderNo, msgId)) {
        logger.debug('Duplicate inbound WSS media frame — skipping', { orderNo, msgId, type });
        return;
      }
      logger.info(`WSS ${type} from seller`, { orderNo, msgId });
      handler({ type, content: data.imageUrl || data.url || data.content || '', msgId, raw: data });
      return;
    }

    logger.debug('Unknown WSS msg type', { orderNo, type });
  }

  // ── Reconnect with capped backoff ─────────────────────────────────────────
  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    // In background mode keep the WSS alive even with zero handlers so we
    // can still receive new-order pushes.
    if (Object.keys(this.handlers).length === 0 && !this._backgroundMode) {
      logger.info('No handlers — skipping reconnect');
      return;
    }

    const MAX_ATTEMPTS = 10;
    const attempt = this.reconnectAttempts + 1;
    this.reconnectAttempts = attempt;

    if (attempt > MAX_ATTEMPTS) {
      logger.error('WSS reconnect circuit broken — giving up', { attempt });
      this.reconnectAttempts = 0;
      return;
    }

    // Token cache may take ~30s to expire — start at 10s, climb to 60s
    const delay = Math.min(60_000, 10_000 * Math.pow(1.5, attempt - 1));
    logger.info('Scheduling WSS reconnect', { attempt, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const seed = Object.keys(this.handlers)[0] || (this._backgroundMode ? '_bootstrap_' : null);
      if (!seed) return;
      try {
        await this.ensureConnected(seed);
      } catch (err) {
        logger.error('Reconnect failed', { attempt, error: err.message });
        this._scheduleReconnect();
      }
    }, delay);
  }

  // ── Send chat message — WSS-only, brief wait then queue if still closed ──
  //  Tries the fast path. If WSS isn't OPEN, waits up to WAIT_OPEN_MS for
  //  it to come up before falling back to the queue. This makes multi-block
  //  template sends (returning-seller, tdsInfo, thankYou) much more reliable
  //  — instead of returning queued and letting the caller race against the
  //  reconnect flush (which can drop messages or send duplicates), we block
  //  the caller for a short, bounded window.
  async sendMessage(orderNo, text) {
    if (this._wssBanned) {
      logger.error('Message dropped — WSS is banned due to ILLEGAL_PARAM', { orderNo });
      return { ok: false, via: 'wss_banned' };
    }

    // Bot kill-switch: if operator toggled bot OFF from the dashboard, drop
    // outbound chat sends silently. Poller / state machine keep running so
    // orders are still tracked in the DB while the bot is muted.
    try {
      const enabled = await botStatusService.isBotEnabled();
      if (!enabled) {
        logger.info('Chat send skipped — bot is OFF', {
          orderNo, preview: String(text).substring(0, 60),
        });
        return { ok: false, via: 'bot_off' };
      }
    } catch (e) { /* fail-open */ }

    // Wait up to WAIT_OPEN_MS for WSS to come OPEN if currently down. Kicks
    // an ensureConnected() if no socket exists at all. Short-circuits the
    // moment the socket flips to OPEN.
    const WAIT_OPEN_MS = 3000;
    const POLL_MS = 100;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (!this.ws && !this.connecting) {
        this.ensureConnected(orderNo).catch(() => {});
      }
      const deadline = Date.now() + WAIT_OPEN_MS;
      while (Date.now() < deadline) {
        if (this.ws?.readyState === WebSocket.OPEN) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }

    // Fast path
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(this._buildOutgoingMsg(orderNo, text)));
        logger.info('Chat msg sent via WSS', { orderNo, preview: String(text).substring(0, 60) });
        return { ok: true, via: 'wss' };
      } catch (err) {
        logger.warn('WSS send threw — queueing', { orderNo, error: err.message });
      }
    }

    if (!this.sendQueues[orderNo]) this.sendQueues[orderNo] = [];
    this.sendQueues[orderNo].push(text);
    logger.warn('Message queued — WSS not open after wait', {
      orderNo,
      readyState: this.ws?.readyState,
      queueLen:   this.sendQueues[orderNo].length,
      preview:    String(text).substring(0, 60),
    });

    // Kick connect if not already
    if (!this.ws && !this.connecting) {
      this.ensureConnected(orderNo).catch(() => {});
    }
    return { ok: false, via: 'queued', queueLen: this.sendQueues[orderNo].length };
  }

  _buildOutgoingMsg(orderNo, text) {
    // Flat format that Binance WS actually accepts (verified working).
    // Critical fields: topicId/topicType/sourceType. NO self/createTime/sendStatus.
    const uuid = uuidv4();
    if (!this._sentUuids) this._sentUuids = new Set();
    this._sentUuids.add(uuid);
    // Keep a uuid → original text map so a later "error" frame from Binance
    // can be correlated back to the exact message that triggered it. Bounded
    // to last 200 outbound messages so memory doesn't grow unbounded.
    if (!this._sentTexts) this._sentTexts = new Map();
    this._sentTexts.set(uuid, { orderNo, text, sentAt: Date.now() });
    if (this._sentTexts.size > 200) {
      const firstKey = this._sentTexts.keys().next().value;
      this._sentTexts.delete(firstKey);
    }
    return {
      type:       'text',
      content:    text,
      topicId:    orderNo,
      topicType:  'ORDER',
      orderNo,
      sourceType: 'contact',
      uuid,
      clientType: 'web',
    };
  }

  // Drain the per-order queue with spacing between sends. A rapid back-to-back
  // burst (the old behaviour) was getting some messages silently dropped by
  // Binance once the queue had > 2 entries — the spaced flush avoids that.
  async _flushSendQueue(orderNo) {
    const q = this.sendQueues[orderNo];
    if (!q || q.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const total = q.length;
    let sent = 0;
    const SPACING_MS = 800;
    while (q.length) {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        logger.warn('Queue flush stopped — WSS closed mid-flush', {
          orderNo, sent, remaining: q.length,
        });
        break;
      }
      const text = q.shift();
      try {
        this.ws.send(JSON.stringify(this._buildOutgoingMsg(orderNo, text)));
        sent++;
      } catch (err) {
        q.unshift(text);
        logger.warn('Queue flush stopped', { orderNo, error: err.message });
        break;
      }
      if (q.length) await new Promise((r) => setTimeout(r, SPACING_MS));
    }
    if (sent > 0) logger.info('Send queue flushed', { orderNo, sent, total });
  }

  // ── Backwards-compatible shims (orderHandler may still call these) ────────
  get connections() {
    // Fake old per-order connections map — true if shared WSS is open
    const open = this.ws?.readyState === WebSocket.OPEN;
    const out = {};
    if (open) Object.keys(this.handlers).forEach(no => { out[no] = this.ws; });
    return out;
  }

  async connect(orderNo, _credentialIgnored, onMessage) {
    // Old API — register + ensure connection
    this.register(orderNo, onMessage);
    await this.ensureConnected(orderNo);
  }

  disconnect(orderNo) {
    this.unregister(orderNo);
    // In background mode we keep the shared WSS alive even with zero active
    // orders — needed so a brand-new order can be detected via push before
    // the next REST poll cycle.
    if (Object.keys(this.handlers).length === 0 && !this._backgroundMode) {
      // Last handler — fully close
      this._closeFully();
    }
  }

  // ── Real-time new-order detection ─────────────────────────────────────────
  //   startBackground() keeps the WSS alive at all times so a fresh order
  //   arriving on Binance pushes an event to us instantly. The new-order
  //   callback (registered by orderPoller) is fired with the orderNo of any
  //   frame for an order we don't yet have a handler for.
  async startBackground() {
    this._backgroundMode = true;
    await this.ensureConnected('_bootstrap_');

    // Proactively refresh the listenKey/credential every 50 minutes. Binance
    // listenKeys are ~60 min lived; closing the socket and letting the
    // existing reconnect path fetch a fresh credential is simpler than a
    // dedicated keepalive endpoint, and means the same code path is exercised.
    if (this._credentialRefreshTimer) clearInterval(this._credentialRefreshTimer);
    this._credentialRefreshTimer = setInterval(() => {
      logger.info('Proactive WSS credential refresh — closing socket so reconnect picks up a fresh listenKey');
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
      }
    }, 50 * 60 * 1000);
  }

  onNewOrder(callback) {
    if (typeof callback !== 'function') return;
    this._newOrderCallback = callback;
    logger.info('Real-time new-order callback registered');
  }

  _closeFully() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this._credentialRefreshTimer) {
      clearInterval(this._credentialRefreshTimer);
      this._credentialRefreshTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.handlers = {};
    this.sendQueues = {};
    this.reconnectAttempts = 0;
    this._backgroundMode = false;
    logger.info('Chat WSS fully closed');
  }

  disconnectAll() {
    this._closeFully();
  }
}

const chatService = new ChatService();
module.exports = { chatService };
