/**
 * ReconnectingWebSocket - A lightweight WebSocket wrapper with automatic reconnection
 * 
 * Features:
 * - Exponential backoff with jitter for reconnection attempts
 * - Safe listener dispatch with error handling
 * - Queue messages during disconnection
 * - Standard WebSocket event interface
 */

class ReconnectingWebSocket {
  constructor(url, protocols = [], options = {}) {
    this._url = url;
    this.protocols = protocols;
    this.options = {
      maxReconnectAttempts: options.maxReconnectAttempts || Infinity,
      reconnectInterval: options.reconnectInterval || 1000,
      maxReconnectInterval: options.maxReconnectInterval || 30000,
      reconnectDecay: options.reconnectDecay || 1.5,
      timeoutInterval: options.timeoutInterval || 2000,
      ...options
    };

    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.forcedClose = false;
    this.timedOut = false;
    this.messageQueue = [];
    
    // Event listeners
    this.listeners = {
      open: [],
      close: [],
      message: [],
      error: []
    };

    this._connect();
  }

  _connect() {
    if (this.forcedClose) return;

    try {
      this.ws = new WebSocket(this._url, this.protocols);
      
      this.ws.onopen = (event) => {
        this.reconnectAttempts = 0;
        this.timedOut = false;
        this._flushMessageQueue();
        this._dispatch('open', event);
      };

      this.ws.onclose = (event) => {
        this.ws = null;
        
        if (this.forcedClose) {
          this._dispatch('close', event);
        } else {
          // Only log reconnect info, not noisy errors
          if (this.reconnectAttempts === 0) {
            console.log('[ReconnectingWebSocket] Connection closed, will attempt to reconnect');
          }
          this._dispatch('close', event);
          this._scheduleReconnect();
        }
      };

      this.ws.onerror = (event) => {
        // Suppress noisy "WebSocket closed before connection established" errors
        // Only dispatch error to listeners, don't log to console
        this._dispatch('error', event);
      };

      this.ws.onmessage = (event) => {
        this._dispatch('message', event);
      };

    } catch (error) {
      console.error('[ReconnectingWebSocket] Connection failed:', error);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.forcedClose) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error('[ReconnectingWebSocket] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    
    // Exponential backoff with jitter
    const baseDelay = this.options.reconnectInterval * Math.pow(this.options.reconnectDecay, this.reconnectAttempts - 1);
    const cappedDelay = Math.min(baseDelay, this.options.maxReconnectInterval);
    const jitter = cappedDelay * 0.1 * Math.random();
    const delay = cappedDelay + jitter;

    console.log(`[ReconnectingWebSocket] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this._connect();
    }, delay);
  }

  _dispatch(type, event) {
    const listeners = this.listeners[type] || [];
    listeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error(`[ReconnectingWebSocket] Error in ${type} listener:`, error);
      }
    });
  }

  _flushMessageQueue() {
    while (this.messageQueue.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift();
      this.ws.send(message);
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      // Queue message for when connection is restored
      this.messageQueue.push(data);
    }
  }

  close(code, reason) {
    this.forcedClose = true;
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(code, reason);
    }
  }

  addEventListener(type, listener) {
    if (this.listeners[type]) {
      this.listeners[type].push(listener);
    }
  }

  removeEventListener(type, listener) {
    if (this.listeners[type]) {
      const index = this.listeners[type].indexOf(listener);
      if (index !== -1) {
        this.listeners[type].splice(index, 1);
      }
    }
  }

  get readyState() {
    return this.ws ? this.ws.readyState : WebSocket.CLOSED;
  }

  get bufferedAmount() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  get extensions() {
    return this.ws ? this.ws.extensions : '';
  }

  get protocol() {
    return this.ws ? this.ws.protocol : '';
  }

  get url() {
    return this._url;
  }
}

export default ReconnectingWebSocket;
