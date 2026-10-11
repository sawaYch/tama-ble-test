(() => {
  const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const RX_CHAR = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
  const TX_CHAR = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

  const params = new URLSearchParams(location.search);
  const store = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };
  const load = k => { try { return sessionStorage.getItem(k); } catch { return null; } };

  if (params.has("ble")) store("tamaBle", params.get("ble") === "0" ? "0" : "1");
  if (params.has("bleChunk")) store("tamaBleChunk", params.get("bleChunk"));
  if (params.has("bleMode")) store("tamaBleMode", params.get("bleMode"));

  const forced = load("tamaBle") === "1";
  if (!navigator.bluetooth) return;
  if (navigator.serial && !forced) return;

  const CHUNK = Math.min(244, Math.max(20, parseInt(load("tamaBleChunk") || "244", 10) || 244));
  const MODE = load("tamaBleMode") === "wr" ? "wr" : "nr";

  const lines = [];
  let overlay = null, pill = null, box = null, expanded = false;

  function render() {
    if (!box) return;
    box.textContent = lines.join("\n");
    box.style.display = expanded ? "block" : "none";
    box.scrollTop = box.scrollHeight;
  }

  function mountOverlay() {
    if (overlay || !document.body) return;
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:2147483647;font:11px/1.3 ui-monospace,monospace;";
    pill = document.createElement("button");
    pill.textContent = "BLE";
    pill.style.cssText = "font:11px ui-monospace,monospace;padding:2px 8px;border-radius:10px;border:1px solid #888;background:#222;color:#9f9;opacity:.8;";
    box = document.createElement("pre");
    box.style.cssText = "display:none;margin:4px 0 0;padding:6px;max-width:90vw;max-height:30vh;overflow:auto;background:rgba(0,0,0,.85);color:#ddd;white-space:pre-wrap;border-radius:6px;";
    pill.onclick = () => { expanded = !expanded; render(); };
    overlay.append(pill, box);
    document.body.appendChild(overlay);
    render();
  }

  function dbg(msg) {
    lines.push(new Date().toLocaleTimeString() + " " + msg);
    if (lines.length > 40) lines.shift();
    console.log("[ble-shim]", msg);
    mountOverlay();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountOverlay);
  } else {
    mountOverlay();
  }

  if (forced && navigator.usb) {
    try { Object.defineProperty(navigator, "usb", { value: undefined, configurable: true }); } catch {}
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function toU8(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return new Uint8Array(chunk);
  }

  class BleSerialPort extends EventTarget {
    constructor(device) {
      super();
      this._device = device;
      this._isOpen = false;
      this._ctrl = null;
      this._rx = null;
      this._tx = null;
      this.readable = null;
      this.writable = null;
      this._onValue = e => {
        const v = e.target.value;
        const copy = new Uint8Array(v.byteLength);
        copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        try { this._ctrl.enqueue(copy); } catch {}
      };
      this._onGone = () => {
        if (!this._isOpen) return;
        this._isOpen = false;
        dbg("disconnected");
        try { this._ctrl.error(new DOMException("Bluetooth disconnected", "NetworkError")); } catch {}
        this.dispatchEvent(new Event("disconnect"));
      };
    }

    getInfo() { return {}; }

    async open() {
      if (this._isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
      dbg("connecting " + (this._device.name || this._device.id));
      const server = await this._device.gatt.connect();
      const svc = await server.getPrimaryService(NUS);
      this._rx = await svc.getCharacteristic(RX_CHAR);
      this._tx = await svc.getCharacteristic(TX_CHAR);

      this.readable = new ReadableStream({ start: c => { this._ctrl = c; } });
      this.writable = new WritableStream({ write: chunk => this._writeAll(toU8(chunk)) });

      this._tx.addEventListener("characteristicvaluechanged", this._onValue);
      this._device.addEventListener("gattserverdisconnected", this._onGone);
      await this._tx.startNotifications();
      this._isOpen = true;
      dbg(`open (chunk ${CHUNK}, ${MODE})`);
    }

    async _writeAll(data) {
      for (let i = 0; i < data.length; i += CHUNK) {
        await this._writeOne(data.slice(i, Math.min(i + CHUNK, data.length)));
      }
    }

    async _writeOne(part) {
      for (let attempt = 0; ; attempt++) {
        try {
          if (MODE === "nr" && this._rx.writeValueWithoutResponse) {
            await this._rx.writeValueWithoutResponse(part);
          } else if (this._rx.writeValueWithResponse) {
            await this._rx.writeValueWithResponse(part);
          } else {
            await this._rx.writeValue(part);
          }
          return;
        } catch (err) {
          if (attempt >= 3 || !this._device.gatt.connected) {
            dbg("write failed: " + err);
            throw err;
          }
          await sleep(20 * (attempt + 1));
        }
      }
    }

    async close() {
      if (!this._isOpen) return;
      this._isOpen = false;
      try { this._tx.removeEventListener("characteristicvaluechanged", this._onValue); } catch {}
      try { this._device.removeEventListener("gattserverdisconnected", this._onGone); } catch {}
      try { await this._tx.stopNotifications(); } catch {}
      try { this._ctrl.close(); } catch {}
      this.readable = null;
      this.writable = null;
      if (this._device.gatt.connected) this._device.gatt.disconnect();
      dbg("closed");
    }

    async forget() { await this.close(); }
    async getSignals() {
      return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: false };
    }
    async setSignals() {}
  }

  class BleSerial extends EventTarget {
    async requestPort() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS] }, { namePrefix: "TamaBLE" }],
        optionalServices: [NUS]
      });
      return new BleSerialPort(device);
    }
    async getPorts() { return []; }
  }

  Object.defineProperty(navigator, "serial", { value: new BleSerial(), configurable: true });
  window.__tamaBleShim = true;
  dbg("shim active");
})();
