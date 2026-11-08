// Client for the Blasta Bank Locker (see locker/worker.js).
// Credentials stay on this device: localStorage if "remember" is ticked, else sessionStorage.

const K_URL = 'blasta.locker.url', K_PW = 'blasta.locker.pw';
export const DEFAULT_LOCKER = 'https://blasta-locker.samuelling.workers.dev';

export class Locker {
  constructor() {
    this.url = localStorage.getItem(K_URL) || DEFAULT_LOCKER;
    this.pub = { banks: [], slots: {} };
    this.pw = localStorage.getItem(K_PW) || sessionStorage.getItem(K_PW) || '';
    this.unlocked = false;
    this.config = {};
  }
  get configured() { return !!(this.url && this.pw); }
  base() { return this.url.replace(/\/+$/, ''); }
  async req(method, path, body, { raw = false, timeout = 15000 } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(this.base() + path, { method, body, headers: { Authorization: 'Bearer ' + this.pw }, signal: ac.signal, cache: 'no-store' });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { msg = (await r.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      return raw ? r : r.json();
    } finally { clearTimeout(t); }
  }
  async unlock(url, pw, remember) {
    this.url = url.trim(); this.pw = pw;
    this.config = await this.req('GET', '/config');
    this.unlocked = true;
    localStorage.setItem(K_URL, this.url);
    if (remember) { localStorage.setItem(K_PW, pw); sessionStorage.removeItem(K_PW); }
    else { sessionStorage.setItem(K_PW, pw); localStorage.removeItem(K_PW); }
  }
  async resume() {                    // silent unlock with saved credentials
    if (!this.configured) return false;
    try { this.config = await this.req('GET', '/config', null, { timeout: 8000 }); this.unlocked = true; return true; }
    catch { this.unlocked = false; return false; }
  }
  lock() { this.pw = ''; this.unlocked = false; this.config = {}; localStorage.removeItem(K_PW); sessionStorage.removeItem(K_PW); }
  list() { return this.req('GET', '/banks'); }
  async download(name) { const r = await this.req('GET', '/banks/' + encodeURIComponent(name), null, { raw: true, timeout: 300000 }); return r.blob(); }
  remove(name) { return this.req('DELETE', '/banks/' + encodeURIComponent(name)); }
  async setSlot(slot, entry) {
    if (entry) this.config[slot] = entry; else delete this.config[slot];
    await this.req('PUT', '/config', JSON.stringify(this.config));
  }
  // ---- public, read-only side (no password) ----
  async publicInfo() {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(this.base() + '/public', { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      this.pub = await r.json();
      return this.pub;
    } finally { clearTimeout(t); }
  }
  async publicDownload(name) {
    const r = await fetch(this.base() + '/public/banks/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }
  async setPublic(pub) {             // owner only
    const r = await this.req('PUT', '/public', JSON.stringify(pub));
    await this.publicInfo();
    return r;
  }
  upload(file, onProgress) {          // XHR for upload progress
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('PUT', this.base() + '/banks/' + encodeURIComponent(file.name));
      x.setRequestHeader('Authorization', 'Bearer ' + this.pw);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText); } catch {}
        x.status < 300 ? res(j) : rej(new Error(j.error || 'HTTP ' + x.status));
      };
      x.onerror = () => rej(new Error('network error'));
      x.send(file);
    });
  }
}
