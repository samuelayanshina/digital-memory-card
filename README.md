# CardNG — Digital Memory Card (Zero-Install Web & Virtual Drive)

A zero-dependency, browser-first **Digital Memory Card** built for Nigeria & Africa. Works across **macOS, Windows, iPhone, and Android** with **0 bytes of `node_modules` bloat**, **SHA-256 Zero-Data Deduplication**, **HTTP 206 Byte-Range Media Streaming**, **WebDAV Native Drive Mounting**, **Local Wi-Fi Zero-Data P2P Beam**, and **OPay/PalmPay + Telegram 1-Tap Verification**.

---

## 1. Run Locally on Your Mac Right Now

```bash
cd /Users/user/.gemini/antigravity/scratch/digital-memory-card
npm start
```

Then open:
* **Mac Browser:** `http://localhost:4000`
* **iPhone / Android (on same Wi-Fi/Hotspot):** Open the LAN URL printed in your terminal (e.g. `http://192.168.x.x:4000`)
* **Mount in Mac Finder as a Physical Drive:** Press `Cmd + K` in Finder and paste your personal WebDAV URL from the **"Mount as Mac / PC Drive"** tab.

Run the automated test suite anytime:
```bash
npm test
```

---

## 2. Connect Your Real Telegram Bot for 1-Tap Mobile Approvals

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)** → send `/newbot` to get your `TELEGRAM_BOT_TOKEN`.
2. Message **[@userinfobot](https://t.me/userinfobot)** to get your personal numeric `TELEGRAM_ADMIN_CHAT_ID`.
3. Copy `.env.example` to `.env` and fill in your OPay/PalmPay account number and Telegram credentials.

---

## 3. Deploying to Oracle Cloud 200GB Always Free Tier

Once your Ubuntu VM with the 200GB Block Volume is mounted at `/mnt/cardng-200gb`:

```bash
STORAGE_ROOT=/mnt/cardng-200gb PORT=4000 node src/server.mjs
```
