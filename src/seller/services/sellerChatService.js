/**
 * Seller chat service — sends messages to the buyer over Binance's chat WSS,
 * using the SELLER key's chat credential.
 *
 * Why WSS (not REST): the REST endpoint /sapi/v1/c2c/chat/sendMessage returns 404
 * on Binance. Messages must go over the same WebSocket the buyer side uses
 * (wss://im.binance.com). This is a SELLER-ONLY implementation — it does NOT touch
 * the buyer chatService.
 *
 * Design: one shared WSS connection (credential fetched lazily and refreshed on
 * reconnect). send() resolves the moment the frame is written; if the socket is
 * not open it opens/queues and flushes on connect. The outgoing frame format is
 * the flat shape Binance accepts (verified on the buyer side).
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');
const sellerBinanceService = require('./sellerBinanceService');

class SellerChatService {
  constructor() {
    this.ws = null;
    this.connecting = false;
    this.credential = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.sendQueue = []; // [{ orderNo, content }]
    this._seedOrderNo = null;
  }

  _buildWssUrl(cred) {
    const { chatWssUrl, listenKey, listenToken } = cred;
    if (chatWssUrl && chatWssUrl.includes('?')) return chatWssUrl;
    if (chatWssUrl && listenKey && chatWssUrl.includes(listenKey)) {
      return `${chatWssUrl}?token=${listenToken}&clientType=web`;
    }
    if (chatWssUrl) {
      const base = chatWssUrl.replace(/\/+$/, '');
      return `${base}/${listenKey}?token=${listenToken}&clientType=web`;
    }
    return null;
  }

  _buildFrame(orderNo, content) {
    // Flat format Binance WS accepts (mirrors the working buyer-side frame).
    return {
      type: 'text',
      content,
      topicId: orderNo,
      topicType: 'ORDER',
      orderNo,
      sourceType: 'contact',
      uuid: uuidv4(),
      clientType: 'web',
    };
  }

  async ensureConnected(seedOrderNo) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return;
    if (seedOrderNo) this._seedOrderNo = seedOrderNo;
    const seed = seedOrderNo || this._seedOrderNo;
    if (!seed) {
      logger.warn('[SellerChat] ensureConnected: no seed orderNo');
      return;
    }

    this.connecting = true;
    try {
      this.credential = await sellerBinanceService.getChatCredential(seed);
      const wssUrl = this._buildWssUrl(this.credential);
      if (!wssUrl) throw new Error('could not build WSS url from credential');

      logger.info('[SellerChat] opening chat WSS');
      const ws = new WebSocket(wssUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectAttempts = 0;
        logger.info('[SellerChat] chat WSS connected');
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch (e) { /* noop */ }
          }
        }, 30_000);
        this._flush();
      });

      ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (data?.type === 'ping' || data?.type === 'PING') {
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) { /* noop */ }
        }
        if (data?.type === 'error') {
          logger.error('[SellerChat] Binance returned error frame', {
            content: String(data.content || '').slice(0, 150),
            orderNo: data.orderNo || data.topicId,
          });
        }
      });

      ws.on('error', (err) => logger.error('[SellerChat] WSS error', { error: err.message }));

      ws.on('close', (code) => {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        this.ws = null;
        logger.warn('[SellerChat] WSS closed', { code });
        this._scheduleReconnect();
      });
    } catch (err) {
      logger.error('[SellerChat] failed to open WSS', { error: err.message });
      this._scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  _scheduleReconnect() {
    if (this.sendQueue.length === 0) return; // nothing pending → reconnect on demand
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 4));
    this.reconnectAttempts++;
    setTimeout(() => this.ensureConnected().catch(() => {}), delay);
  }

  _flush() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.sendQueue.length) {
      const { orderNo, content } = this.sendQueue.shift();
      try {
        this.ws.send(JSON.stringify(this._buildFrame(orderNo, content)));
        logger.info('[SellerChat] message sent', { orderNo, preview: String(content).slice(0, 60) });
      } catch (err) {
        // Put it back and stop; reconnect will retry.
        this.sendQueue.unshift({ orderNo, content });
        logger.warn('[SellerChat] send threw — requeued', { orderNo, error: err.message });
        break;
      }
    }
  }

  /**
   * Send a text message to the buyer on an order. Resolves { success }.
   * Waits briefly for the socket to open if it isn't yet.
   */
  async send(orderNo, content) {
    if (!orderNo || !content) return { success: false, message: 'missing orderNo/content' };

    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.ensureConnected(orderNo).catch(() => {});
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (this.ws?.readyState === WebSocket.OPEN) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(this._buildFrame(orderNo, content)));
        logger.info('[SellerChat] message sent', { orderNo, preview: String(content).slice(0, 60) });
        return { success: true };
      } catch (err) {
        logger.warn('[SellerChat] send threw — queueing', { orderNo, error: err.message });
      }
    }

    // Not open — queue and let the flush deliver it.
    this.sendQueue.push({ orderNo, content });
    return { success: true, queued: true };
  }
}

const sellerChatService = new SellerChatService();
module.exports = { sellerChatService };
