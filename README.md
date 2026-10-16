# CardNG — Digital Memory Card for Nigeria & Africa

**CardNG** is a zero-install, ultra-fast **Digital Memory Card** engineered to solve chronic device storage shortages (`64GB iPhones`, `Android phones`, and `256GB MacBooks / Windows PCs`) without burning expensive mobile data or requiring international credit cards.

---

## ✨ Why CardNG Exists

1. **Zero-Login Instant Provisioning:** Open the app and immediately receive a **5 GB Free Starter Digital Memory Card** (`NG-SD-XXXX-XXXX`) bound to an `HttpOnly` cryptographic session token.
2. **4-Layer Zero-Data / Ultra-Low-Data Architecture:**
   - **Layer 1 — Local Wi-Fi / Hotspot Direct Offload & P2P Beam (`0.00 MB` Internet Data):** Offload gigabytes from an iPhone or Android to a Mac/PC over a local phone hotspot (`http://192.168.x.x:4000`) even with mobile data switched completely **OFF**.
   - **Layer 2 — Cloud Direct URL Fetch (`0.00 MB` Phone Data — `POST /api/files/remote-fetch`):** Paste any direct URL to a lecture video, PDF, or archive; the CardNG server downloads it directly into your cloud card at `1,000 Mbps` without using a single byte of your phone's data or storage.
   - **Layer 3 — SHA-256 Content-Addressable Deduplication & Share Codes (`0.00 MB` Upload Data):** Before uploading, the browser computes the file's SHA-256 hash (`POST /api/files/preflight`). If the blob already exists on the server—or is shared via a `CARD-XXXX` Share Code—it mounts onto your card in `0.1s` using **0 Bytes** of network traffic.
   - **Layer 4 — On-Device GZIP Pre-Upload Stream Compression (`x-upload-encoding: gzip`):** Compresses source code, documents, and datasets in browser RAM via `CompressionStream('gzip')` before upload and decompresses them on the fly via `node:zlib` on the server—saving **60%–85% of mobile data**.
3. **Zero-Storage Streaming & Cloud Code Studio:**
   - **HTTP 206 Partial Content Media Theater:** Stream 1080p/4K videos, audio notes, and PDFs directly from your Digital Memory Card with instant byte-range seeking and **0 Bytes** written to local disk.
   - **Cloud Code Studio (`POST /api/workspace/run`):** Create, edit, save, and execute JavaScript/JSON/Markdown/Python files directly on your Cloud Card inside a sandboxed `node:vm` runtime.
   - **256GB MacBook Storage Doctor (`GET /api/system/mac-doctor`):** Scans macOS developer caches (`Xcode DerivedData`, `npm`, `CocoaPods`, `Docker`, `Homebrew`) to help reclaim `10GB–40GB+` of SSD space.
   - **Native WebDAV Virtual Disk (`/webdav/<token>`):** Mount your Digital Memory Card directly inside **macOS Finder (`Cmd + K`)** or **Windows File Explorer (`Z:\`)** as a native external drive.
4. **Nigerian Sachet Pricing + Instant OPay / PalmPay & Telegram 1-Tap Bot:**
   - **5 GB Free Starter Card:** `₦0`
   - **20 GB Student Card:** `₦250 / 30 days`
   - **50 GB Everyday Card:** `₦500 / 30 days`
   - **150 GB Pro / Creator Card:** `₦1,200 / 30 days`
   - Zero CAC bottleneck required to launch: users pay via instant **OPay / PalmPay** transfer, and the admin approves in **1 tap inside Telegram** (`POST /api/telegram/webhook`), pushing a real-time **Server-Sent Event (SSE)** upgrade and an official printable **Nigerian Transaction Receipt (`NG-RCPT-XXXXXX`)** to the user's screen in `< 1 second`.

---

## 🔒 Cybersecurity & Zero-Trust Hardening

- **Server-Enforced Private Vault (`HMAC-SHA256`):** Files inside the Private Vault cannot be streamed (`/api/files/:id/stream`) or shared (`/api/files/:id/share`) until the user's 4-digit PIN is verified (`POST /api/auth/verify-pin`) and a signed `cardng_vault` `HttpOnly` token is issued.
- **Cryptographic PIN Hashing & ₦0 SMS Recovery Key:** Phone PINs are salted and hashed with `crypto.scryptSync` and verified via constant-time `crypto.timingSafeEqual`. Locking a card generates a one-time **Emergency Recovery Key (`NG-REC-XXXX-XXXX`)** for instant, ₦0 SMS-free PIN resets (`POST /api/auth/reset-pin`).
- **SSRF Protection:** Cloud Direct URL Fetch blocks loopback, RFC1918 private LAN IPs, and cloud metadata endpoints (`169.254.169.254`).
- **Tamper-Evident Security Audit Ledger (`GET /api/security/audit`):** Logs card provisioning, PIN verification, vault unlocks, and transfer approvals with masked client IPs.
- **Strict Security Headers:** Enforces `Content-Security-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and token-bucket rate limiting.

---

## 🚀 Quick Start (Zero External Dependencies)

CardNG is built 100% on native **Node.js 20+** standard libraries (`node:http`, `node:crypto`, `node:fs`, `node:zlib`, `node:vm`, `node:test`) with **0 external `node_modules`**.

```bash
# 1. Start the Digital Memory Card Server
npm start

# 2. Run the 13-test End-to-End & Security QA Suite
npm test
```

Once running:
- **Mac / PC Browser:** `http://localhost:4000`
- **iPhone / Android (Zero-Data Local Wi-Fi / Hotspot):** `http://<your-local-ip>:4000`
- **macOS Finder / Windows Explorer WebDAV Mount:** `http://localhost:4000/webdav/<your-token>`

---

## ☁️ Production Deployment (Docker / Oracle Cloud 200GB Free Tier)

```bash
docker compose up -d --build
```
