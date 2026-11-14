"use strict";
/*
 * Google Drive Sync — a custom Obsidian plugin.
 * Two-way sync between this vault and a folder in your Google Drive.
 * Uses Google's "TV / limited-input device" sign-in so it works on phones too,
 * and only the drive.file scope (the plugin can only see files it created).
 */
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  TFile,
  requestUrl,
} = require("obsidian");

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,size,mimeType";
const MULTIPART_LIMIT = 4 * 1024 * 1024; // bigger files use resumable upload
const CONCURRENCY = 4;

const DEFAULTS = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  remoteFolderName: "",
  autoSyncMinutes: 5,
  syncOnStartup: true,
  excludes: ".trash/",
  lastSync: 0,
  // sync bookkeeping (do not edit)
  stateFolderId: "",
  state: {}, // path -> { id, md5, mtime, size }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const form = (obj) => new URLSearchParams(obj).toString();
const safeJson = (r) => {
  try {
    return r.json;
  } catch (e) {
    return null;
  }
};
const safeText = (r) => {
  try {
    return r.text || "";
  } catch (e) {
    return "";
  }
};
const qEscape = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function isSafeVaultPath(path, configDir) {
  if (typeof path !== "string" || !path || path.length > 1024) return false;

  if (/[\x00-\x1f\x7f]/.test(path)) return false; // control characters

  if (path.includes("\\")) return false; // Windows separators / escapes

  if (path.startsWith("/") || path.endsWith("/")) return false;

  if (/^[A-Za-z]:/.test(path)) return false; // drive-letter paths like C:/...

  const segments = path.split("/");

  for (const seg of segments) {
    if (!seg.trim()) return false; // empty ("a//b") or whitespace-only segment

    if (seg.startsWith(".")) return false; // ".", "..", hidden files and folders
  }

  if (configDir) {
    const cd = configDir.replace(/^\/+|\/+$/g, "");
    if (cd && (path === cd || path.startsWith(cd + "/"))) return false;
  }
  return true;
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;

  const x = new Uint8Array(a),
    y = new Uint8Array(b);

  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;

  return true;
}

async function runPool(items, n, fn) {
  let i = 0;

  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      await fn(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function stamp() {
  const d = new Date(),
    p = (v) => String(v).padStart(2, "0");

  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

module.exports = class GDriveSyncPlugin extends Plugin {
  async onload() {
    this.syncing = false;
    this.accessToken = null;
    this.accessTokenExpiry = 0;
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.setStatus(
      this.settings.lastSync
        ? `GDrive: synced ${new Date(this.settings.lastSync).toLocaleTimeString()}`
        : "GDrive: idle",
    );

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () =>
      this.sync(true),
    );
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.sync(true),
    });
    this.addSettingTab(new GDriveSettingTab(this.app, this));

    this.setupAutoSync();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup) setTimeout(() => this.sync(false), 3000);
    });
  }

  onunload() {
    if (this.intervalId) window.clearInterval(this.intervalId);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    if (!this.settings.state) this.settings.state = {};
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  setupAutoSync() {
    if (this.intervalId) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const mins = Number(this.settings.autoSyncMinutes);
    if (mins > 0) {
      this.intervalId = window.setInterval(
        () => this.sync(false),
        mins * 60 * 1000,
      );
      this.registerInterval(this.intervalId);
    }
  }

  setStatus(t) {
    if (this.statusEl) this.statusEl.setText(t);
  }
  folderName() {
    return (
      (this.settings.remoteFolderName || "").trim() ||
      `Obsidian - ${this.app.vault.getName()}`
    );
  }
  excludeList() {
    return (this.settings.excludes || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  isExcluded(path) {
    return this.excludeList().some(
      (ex) => path === ex || path.startsWith(ex.endsWith("/") ? ex : ex + "/"),
    );
  }
  isSafePath(path) {
    return isSafeVaultPath(path, this.app.vault.configDir);
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60000)
      return this.accessToken;
    const s = this.settings;
    if (!s.refreshToken)
      throw new Error(
        'Not connected. Open the plugin settings and click "Connect".',
      );
    const r = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      throw: false,
      body: form({
        client_id: s.clientId,
        client_secret: s.clientSecret,
        refresh_token: s.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const j = safeJson(r) || {};
    if (r.status !== 200) {
      if (j.error === "invalid_grant") {
        s.refreshToken = "";
        await this.saveSettings();
        throw new Error(
          'Google sign-in expired or was revoked. Click "Connect" in the plugin settings again.',
        );
      }
      throw new Error(
        `Token refresh failed (${r.status}): ${j.error_description || j.error || safeText(r)}`,
      );
    }
    this.accessToken = j.access_token;
    this.accessTokenExpiry = Date.now() + (j.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async connect() {
    const s = this.settings;
    if (!s.clientId || !s.clientSecret)
      throw new Error("Enter your Client ID and Client secret first.");
    const r = await requestUrl({
      url: DEVICE_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      throw: false,
      body: form({ client_id: s.clientId, scope: SCOPE }),
    });
    const d = safeJson(r) || {};
    if (r.status !== 200)
      throw new Error(
        `Could not start sign-in (${r.status}): ${d.error_description || d.error || safeText(r)}. Make sure the OAuth client type is "TVs and Limited Input devices".`,
      );

    const modal = new DeviceCodeModal(
      this.app,
      d.user_code,
      d.verification_url || "https://www.google.com/device",
    );
    modal.open();
    const deadline = Date.now() + (d.expires_in || 1800) * 1000;
    let wait = (d.interval || 5) * 1000;
    while (Date.now() < deadline) {
      await sleep(wait);
      if (modal.cancelled) throw new Error("Sign-in cancelled.");
      const t = await requestUrl({
        url: TOKEN_URL,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        throw: false,
        body: form({
          client_id: s.clientId,
          client_secret: s.clientSecret,
          device_code: d.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const j = safeJson(t) || {};
      if (t.status === 200 && j.refresh_token) {
        s.refreshToken = j.refresh_token;
        this.accessToken = j.access_token;
        this.accessTokenExpiry = Date.now() + (j.expires_in || 3600) * 1000;
        await this.saveSettings();
        modal.finish();
        new Notice("Google Drive connected ✅");
        return;
      }
      if (j.error === "authorization_pending") continue;
      if (j.error === "slow_down") {
        wait += 5000;
        continue;
      }
      modal.finish();
      throw new Error(
        `Sign-in failed: ${j.error_description || j.error || t.status}`,
      );
    }
    modal.finish();
    throw new Error("Sign-in timed out. Try again.");
  }

  // ---------------------------------------------------------------- drive api
  async api(opts, attempt = 0) {
    const token = await this.getAccessToken();
    const r = await requestUrl(
      Object.assign({}, opts, {
        headers: Object.assign({}, opts.headers || {}, {
          Authorization: `Bearer ${token}`,
        }),
        throw: false,
      }),
    );
    if (r.status === 401 && attempt < 1) {
      this.accessToken = null;
      return this.api(opts, attempt + 1);
    }
    const retryable =
      r.status === 429 ||
      r.status >= 500 ||
      (r.status === 403 && /rate|quota/i.test(safeText(r)));
    if (retryable && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      return this.api(opts, attempt + 1);
    }
    if (r.status < 200 || r.status >= 300)
      throw new Error(
        `Google Drive error ${r.status}: ${safeText(r).slice(0, 300)}`,
      );
    return r;
  }

  async getRemoteFolderId() {
    const name = this.folderName();
    const q = `name='${qEscape(name)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
    const r = await this.api({
      url: `${API}/files?${new URLSearchParams({ q, fields: "files(id,name)", orderBy: "createdTime", spaces: "drive" })}`,
    });
    const files = (r.json && r.json.files) || [];
    if (files.length) return files[0].id;
    const c = await this.api({
      url: `${API}/files?fields=id`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    return c.json.id;
  }

  async listRemote(folderId) {
    const out = new Map();
    let pageToken;
    do {
      const p = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      });
      if (pageToken) p.set("pageToken", pageToken);
      const r = await this.api({ url: `${API}/files?${p}` });
      for (const f of r.json.files || []) {
        if (f.mimeType === FOLDER_MIME) continue;
        if (!this.isSafePath(f.name)) {
          console.warn(
            `[gdrive-sync] Ignoring remote file with an unsafe name: ${JSON.stringify(f.name)} (id ${f.id})`,
          );
          continue;
        }
        const prev = out.get(f.name);
        if (!prev || f.modifiedTime > prev.modifiedTime) out.set(f.name, f); // duplicates: newest wins
      }
      pageToken = r.json.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(id) {
    const r = await this.api({ url: `${API}/files/${id}?alt=media` });
    return r.arrayBuffer;
  }

  async upload(path, data, existingId, folderId) {
    const meta = existingId ? {} : { name: path, parents: [folderId] };
    const base = existingId
      ? `${UPLOAD}/files/${existingId}`
      : `${UPLOAD}/files`;
    const method = existingId ? "PATCH" : "POST";

    if (data.byteLength <= MULTIPART_LIMIT) {
      const boundary = "obsgd" + Math.random().toString(36).slice(2);
      const enc = new TextEncoder();
      const head = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const tail = enc.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + data.byteLength + tail.length);
      body.set(head, 0);
      body.set(new Uint8Array(data), head.length);
      body.set(tail, head.length + data.byteLength);
      const r = await this.api({
        url: `${base}?uploadType=multipart&fields=${FILE_FIELDS}`,
        method,
        contentType: `multipart/related; boundary=${boundary}`,
        body: body.buffer,
      });
      return r.json;
    }
    // resumable upload for large attachments
    const init = await this.api({
      url: `${base}?uploadType=resumable&fields=${FILE_FIELDS}`,
      method,
      contentType: "application/json; charset=UTF-8",
      body: JSON.stringify(meta),
      headers: { "X-Upload-Content-Type": "application/octet-stream" },
    });
    const h = init.headers || {};
    const loc =
      h.location ||
      h.Location ||
      Object.keys(h)
        .filter((k) => k.toLowerCase() === "location")
        .map((k) => h[k])[0];
    if (!loc) throw new Error("Resumable upload: no upload URL returned");
    const r = await this.api({
      url: loc,
      method: "PUT",
      contentType: "application/octet-stream",
      body: data,
    });
    return r.json;
  }

  async trashRemote(id) {
    await this.api({
      url: `${API}/files/${id}?fields=id`,
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }

  // ---------------------------------------------------------------- local fs
  async ensureFolder(dir) {
    if (!dir) return;
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          /* created concurrently */
        }
      }
    }
  }

  async writeLocal(path, data) {
    // Defense in depth: never write outside plain vault paths, whatever the caller.
    if (!this.isSafePath(path))
      throw new Error(`Refusing to write unsafe path ${JSON.stringify(path)}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
    } else {
      const i = path.lastIndexOf("/");
      await this.ensureFolder(i > 0 ? path.slice(0, i) : "");
      await this.app.vault.createBinary(path, data);
    }
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile
      ? { mtime: f.stat.mtime, size: f.stat.size }
      : { mtime: Date.now(), size: data.byteLength };
  }

  async trashLocal(file) {
    if (this.app.fileManager && this.app.fileManager.trashFile)
      await this.app.fileManager.trashFile(file);
    else await this.app.vault.trash(file, false);
  }

  conflictPath(path) {
    const slash = path.lastIndexOf("/"),
      dot = path.lastIndexOf(".");
    const hasExt = dot > slash + 1;
    const stem = hasExt ? path.slice(0, dot) : path,
      ext = hasExt ? path.slice(dot) : "";
    let n = 0,
      out;
    do {
      out = `${stem} (conflict ${stamp()}${n ? " " + n : ""})${ext}`;
      n++;
    } while (this.app.vault.getAbstractFileByPath(out));
    return out;
  }

  // ---------------------------------------------------------------- sync
  async sync(manual) {
    if (this.syncing) {
      if (manual) new Notice("Sync is already running…");
      return;
    }
    if (!this.settings.refreshToken) {
      if (manual)
        new Notice(
          "Google Drive Sync: not connected yet. Open the plugin settings.",
        );
      return;
    }
    this.syncing = true;
    this.setStatus("GDrive: syncing…");
    const stats = {
      up: 0,
      down: 0,
      delLocal: 0,
      delRemote: 0,
      conflicts: 0,
      errors: 0,
    };
    try {
      const folderId = await this.getRemoteFolderId();
      let state = this.settings.state || {};
      // New/changed remote folder → forget old bookkeeping so nothing gets deleted by mistake.
      if (this.settings.stateFolderId !== folderId) state = {};

      const local = new Map();
      // Unsafe names are skipped on both sides, so a local file the remote side
      // would ignore is never re-uploaded as a duplicate on every sync.
      for (const f of this.app.vault.getFiles()) {
        if (this.isExcluded(f.path)) continue;
        if (!this.isSafePath(f.path)) {
          console.warn(
            `[gdrive-sync] Skipping local file with an unsupported name: ${JSON.stringify(f.path)}`,
          );
          continue;
        }
        local.set(f.path, f);
      }
      const remote = await this.listRemote(folderId);

      // Safety: if either side is completely empty, never propagate mass deletions.
      if (Object.keys(state).length && (remote.size === 0 || local.size === 0))
        state = {};

      const paths = [
        ...new Set([...local.keys(), ...remote.keys(), ...Object.keys(state)]),
      ].filter((p) => !this.isExcluded(p) && this.isSafePath(p));
      const newState = {};
      let done = 0;

      await runPool(paths, CONCURRENCY, async (path) => {
        try {
          const rec = await this.syncOne(
            path,
            local.get(path),
            remote.get(path),
            state[path],
            folderId,
            stats,
            newState,
          );
          if (rec) newState[path] = rec;
        } catch (e) {
          stats.errors++;
          console.error(`[gdrive-sync] ${path}:`, e);
          if (state[path]) newState[path] = state[path];
        }
        done++;
        if (done % 10 === 0)
          this.setStatus(`GDrive: syncing ${done}/${paths.length}`);
        if (done % 50 === 0) {
          // checkpoint for long first syncs
          this.settings.state = Object.assign({}, state, newState);
          this.settings.stateFolderId = folderId;
          await this.saveSettings();
        }
      });

      this.settings.state = newState;
      this.settings.stateFolderId = folderId;
      this.settings.lastSync = Date.now();
      await this.saveSettings();

      const parts = [];
      if (stats.up) parts.push(`↑${stats.up}`);
      if (stats.down) parts.push(`↓${stats.down}`);
      if (stats.delLocal + stats.delRemote)
        parts.push(`🗑${stats.delLocal + stats.delRemote}`);
      if (stats.conflicts) parts.push(`⚠️ ${stats.conflicts} conflict(s)`);
      if (stats.errors) parts.push(`❌ ${stats.errors} error(s) (see console)`);
      this.setStatus(`GDrive: synced ${new Date().toLocaleTimeString()}`);
      if (manual || stats.conflicts || stats.errors) {
        new Notice(
          `Google Drive sync done${parts.length ? ": " + parts.join("  ") : " — everything up to date"}`,
        );
      }
    } catch (e) {
      console.error("[gdrive-sync]", e);
      this.setStatus("GDrive: sync failed");
      new Notice(`Google Drive sync failed: ${e.message}`, 10000);
    } finally {
      this.syncing = false;
    }
  }

  async syncOne(path, L, R, P, folderId, stats, newState) {
    const rec = (rf, st) => ({
      id: rf.id,
      md5: rf.md5Checksum,
      mtime: st.mtime,
      size: st.size,
    });
    const lChanged =
      !P || !L || L.stat.mtime !== P.mtime || L.stat.size !== P.size;
    const rChanged = !P || !R || R.id !== P.id || R.md5Checksum !== P.md5;

    const pushLocal = async (existingId) => {
      const st = { mtime: L.stat.mtime, size: L.stat.size };
      const data = await this.app.vault.readBinary(L);
      const rf = await this.upload(path, data, existingId, folderId);
      stats.up++;
      return rec(rf, st);
    };
    const pullRemote = async () => {
      const data = await this.download(R.id);
      const st = await this.writeLocal(path, data);
      stats.down++;
      return rec(R, st);
    };

    if (L && R) {
      if (P && !lChanged && !rChanged) return P;
      if (P && lChanged && !rChanged) return pushLocal(R.id);
      if (P && !lChanged && rChanged) return pullRemote();
      // Changed on both sides, or first time we see this file on both sides.
      const remoteData = await this.download(R.id);
      const localData = await this.app.vault.readBinary(L);
      if (bytesEqual(remoteData, localData)) return rec(R, L.stat);
      // Keep this device's version in place; save the other version as a conflict copy.
      const cp = this.conflictPath(path);
      const cst = await this.writeLocal(cp, remoteData);
      const crf = await this.upload(cp, remoteData, null, folderId); // share the conflict copy right away
      newState[cp] = rec(crf, cst);
      stats.conflicts++;
      return pushLocal(R.id);
    }
    if (L && !R) {
      if (P && !lChanged) {
        await this.trashLocal(L);
        stats.delLocal++;
        return null;
      } // deleted on other device
      return pushLocal(null); // new (or edited after remote deletion → keep it)
    }
    if (!L && R) {
      if (P && !rChanged) {
        await this.trashRemote(R.id);
        stats.delRemote++;
        return null;
      } // deleted here
      return pullRemote(); // new remote file (or edited remotely after local deletion → keep it)
    }
    return null;
  }
};

class DeviceCodeModal extends Modal {
  constructor(app, code, url) {
    super(app);
    this.code = code;
    this.url = url;
    this.cancelled = false;
    this.finished = false;
  }
  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: "Connect Google Drive" });
    el.createEl("p", { text: "1. On any device, open:" });
    el.createEl("a", { text: this.url, href: this.url });
    el.createEl("p", { text: "2. Sign in and enter this code:" });
    const c = el.createEl("div", { text: this.code });
    c.style.cssText =
      "font-size:2em;font-family:monospace;letter-spacing:0.15em;text-align:center;margin:12px 0;user-select:text;";
    new Setting(el)
      .addButton((b) =>
        b.setButtonText("Copy code").onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.code);
            new Notice("Code copied");
          } catch (e) {
            /* ignore */
          }
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Open page")
          .setCta()
          .onClick(() => window.open(this.url)),
      );
    el.createEl("p", {
      text: 'This window closes by itself after you click "Allow".',
      cls: "setting-item-description",
    });
  }
  finish() {
    this.finished = true;
    this.close();
  }
  onClose() {
    if (!this.finished) this.cancelled = true;
    this.contentEl.empty();
  }
}

class GDriveSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin,
      s = p.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Google Drive Sync" });

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc(
        'From Google Cloud → OAuth client of type "TVs and Limited Input devices". Use the same one on every device.',
      )
      .addText((t) =>
        t.setValue(s.clientId).onChange(async (v) => {
          s.clientId = v.trim();
          await p.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.clientSecret).onChange(async (v) => {
        s.clientSecret = v.trim();
        await p.saveSettings();
      });
    });

    const acct = new Setting(containerEl)
      .setName("Google account")
      .setDesc(s.refreshToken ? "✅ Connected" : "Not connected");
    if (s.refreshToken) {
      acct.addButton((b) =>
        b.setButtonText("Disconnect").onClick(async () => {
          s.refreshToken = "";
          p.accessToken = null;
          await p.saveSettings();
          this.display();
        }),
      );
    } else {
      acct.addButton((b) =>
        b
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            try {
              await p.connect();
            } catch (e) {
              new Notice(e.message, 10000);
            }
            this.display();
          }),
      );
    }

    new Setting(containerEl)
      .setName("Drive folder name")
      .setDesc(
        `Folder in the root of your Drive. Must be the SAME on all devices. Default: "Obsidian - ${p.app.vault.getName()}"`,
      )
      .addText((t) =>
        t
          .setPlaceholder(`Obsidian - ${p.app.vault.getName()}`)
          .setValue(s.remoteFolderName)
          .onChange(async (v) => {
            s.remoteFolderName = v;
            await p.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync every (minutes)")
      .setDesc("0 = off")
      .addText((t) =>
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.autoSyncMinutes = isNaN(n) || n < 0 ? 0 : n;
          await p.saveSettings();
          p.setupAutoSync();
        }),
      );

    new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await p.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc(
        'One folder or file per line, e.g. "Private/" or "big-video.mp4"',
      )
      .addTextArea((t) =>
        t.setValue(s.excludes).onChange(async (v) => {
          s.excludes = v;
          await p.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(
        s.lastSync
          ? `Last sync: ${new Date(s.lastSync).toLocaleString()}`
          : "Never synced",
      )
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            await p.sync(true);
            this.display();
          }),
      );
  }
}
