const state = {
  user: null,
  files: [],
  payments: [],
  pendingAdminClaims: [],
  plans: {},
  merchant: {},
  webdavUrl: '',
  lanUrl: '',
  activeView: 'view-files',
  activeFolder: 'ALL',
  searchQuery: '',
  vaultUnlocked: false,
  p2pPeerId: `peer_${Math.random().toString(36).slice(2, 8)}`,
  p2pRoomCode: null,
  p2pEventSource: null
};

function formatBytes(bytes = 0) {
  const num = Number(bytes) || 0;
  if (num === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(1024)), units.length - 1);
  const val = num / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showBanner(msg, isError = false) {
  const banner = document.getElementById('liveBanner');
  if (!banner) return;
  banner.textContent = msg;
  banner.style.borderColor = isError ? '#fecaca' : '#a7f3d0';
  banner.style.background = isError ? '#fef2f2' : '#ecfdf5';
  banner.style.color = isError ? '#b91c1c' : '#047857';
  banner.classList.remove('hidden');
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => banner.classList.add('hidden'), 5500);
}

async function computeFileSha256(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getFileSvgIcon(mime = '', name = '') {
  if (mime.startsWith('video/')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }
  if (mime.startsWith('audio/')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  }
  if (mime.startsWith('image/')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  }
  if (name.endsWith('.py') || name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.json')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

function switchView(viewId, folder = null) {
  state.activeView = viewId;
  if (folder) {
    state.activeFolder = folder;
    const heading = document.getElementById('currentFolderHeading');
    if (heading) {
      heading.textContent = folder === 'ALL' ? 'All Files' : folder;
    }
  }

  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === viewId);
  });

  document.querySelectorAll('.nav-item').forEach((btn) => {
    const btnView = btn.dataset.view;
    const btnFolder = btn.dataset.folder;
    if (viewId === 'view-files' && btnFolder) {
      btn.classList.toggle('active', btnFolder === state.activeFolder);
    } else {
      btn.classList.toggle('active', btnView === viewId && !btnFolder);
    }
  });

  if (viewId === 'view-files') {
    renderFiles();
  }
}

function renderCardHeader() {
  const user = state.user;
  if (!user) return;

  const plan = state.plans[user.planId] || {
    badge: 'FREE STARTER',
    quotaLabel: formatBytes(user.quotaBytes)
  };
  document.getElementById('cardPlanBadge').textContent = plan.badge || user.planName.toUpperCase();
  document.getElementById('cardCapacityTitle').textContent =
    plan.quotaLabel || formatBytes(user.quotaBytes);
  document.getElementById('cardSerialText').textContent = user.cardSerial;

  const used = user.usedBytes || 0;
  const quota = user.quotaBytes || 1;
  const remaining = Math.max(0, quota - used);
  const pct = Math.min(100, Math.max(1.5, (used / quota) * 100));

  document.getElementById('usedSpaceText').textContent = `${formatBytes(used)} used`;
  document.getElementById('freeSpaceText').textContent = `${formatBytes(remaining)} free`;
  document.getElementById('storageProgressBar').style.width = `${pct}%`;
  document.getElementById('savedDataMetric').textContent = `${formatBytes(
    user.savedDataBytes || 0
  )}`;

  const lockBtnText = document.getElementById('lockStatusBtnText');
  const ownerStatus = document.getElementById('cardOwnerStatusText');
  if (user.isLockedToPhone) {
    lockBtnText.textContent = `Protected (${user.phone})`;
    ownerStatus.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(
      user.displayName
    )} · ${escapeHtml(user.phone)}</span>`;
  } else {
    lockBtnText.textContent = 'Lock to Phone + PIN';
    ownerStatus.innerHTML = `<span class="status-dot"></span><span>Guest Card (${escapeHtml(
      user.cardSerial
    )})</span>`;
  }

  document.getElementById('webdavUrlInput').value = state.webdavUrl;
  document.getElementById('lanUrlText').textContent = state.lanUrl;
}

function renderFiles() {
  const grid = document.getElementById('filesGrid');
  document.getElementById('fileCountPill').textContent = String(state.files.length);

  if (state.activeFolder === 'Private Vault' && !state.vaultUnlocked) {
    grid.innerHTML = `
      <div class="surface-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem;">
        <h3 style="margin-bottom: 0.35rem;">Private Vault Locked</h3>
        <p class="helper-caption" style="max-width: 400px; margin: 0 auto 1.25rem;">
          Enter your 4-digit security PIN (default is <code>0000</code> on guest cards) to view or stream files in your vault.
        </p>
        <div style="display: flex; gap: 0.5rem; justify-content: center; max-width: 280px; margin: 0 auto;">
          <input type="password" id="vaultPinPromptInput" class="input mono" placeholder="4-Digit PIN" maxlength="4" inputmode="numeric" />
          <button class="btn btn-primary" id="btnUnlockVaultNow">Unlock</button>
        </div>
      </div>
    `;
    const btnUnlock = document.getElementById('btnUnlockVaultNow');
    if (btnUnlock) btnUnlock.addEventListener('click', unlockVaultWithPin);
    return;
  }

  const filtered = state.files.filter((file) => {
    if (state.activeFolder === 'Private Vault') {
      if (!file.isVaultLocked) return false;
    } else if (state.activeFolder !== 'ALL') {
      if (file.isVaultLocked || file.folder !== state.activeFolder) return false;
    } else {
      if (file.isVaultLocked && !state.vaultUnlocked) return false;
    }

    if (state.searchQuery) {
      return file.name.toLowerCase().includes(state.searchQuery.toLowerCase());
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="surface-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem;">
        <h3 style="font-size: 1.05rem; margin-bottom: 0.35rem;">Your Digital Memory Card is Ready</h3>
        <p class="helper-caption" style="max-width: 440px; margin: 0 auto 1.15rem;">
          Drop any movie, photo, or code archive into the bar above to offload it from your device — or load sample files to test instant streaming.
        </p>
        <button type="button" class="btn btn-outline btn-sm" id="btnEmptySeedDemo">
          Load Sample Audio & Code Files
        </button>
      </div>
    `;
    const emptySeedBtn = document.getElementById('btnEmptySeedDemo');
    if (emptySeedBtn) {
      emptySeedBtn.addEventListener('click', () =>
        document.getElementById('btnSeedDemoFiles').click()
      );
    }
    return;
  }

  grid.innerHTML = filtered
    .map(
      (file) => `
    <article class="file-card">
      <div>
        <div class="file-card-top">
          <div class="file-type-icon">${getFileSvgIcon(file.mimeType, file.name)}</div>
          <div class="file-info">
            <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
            <div class="file-meta">
              ${formatBytes(file.sizeBytes)} · ${escapeHtml(file.folder)}
            </div>
          </div>
        </div>

        <div class="file-badges" style="margin-top: 0.7rem;">
          <span class="safe-badge">Verified · Safe to delete locally</span>
          ${file.deduplicated ? `<span class="dedup-badge">0 MB Data Used</span>` : ''}
          ${file.isVaultLocked ? `<span class="dedup-badge">Vault</span>` : ''}
        </div>
      </div>

      <div class="file-actions">
        <button class="btn btn-primary btn-xs" data-action="stream" data-id="${file.id}">
          Stream
        </button>
        <a href="${file.downloadUrl}" class="btn btn-outline btn-xs" download="${escapeHtml(
          file.name
        )}">
          Download
        </a>
        <button class="btn btn-ghost btn-xs" data-action="toggle-vault" data-id="${file.id}">
          ${file.isVaultLocked ? 'Unvault' : 'Vault'}
        </button>
        <button class="btn btn-danger btn-xs" style="margin-left: auto;" data-action="delete" data-id="${
          file.id
        }">
          Delete
        </button>
      </div>
    </article>
  `
    )
    .join('');
}

async function unlockVaultWithPin() {
  const pinInput = document.getElementById('vaultPinPromptInput');
  const pin = pinInput ? pinInput.value.trim() : '';
  const res = await fetch('/api/auth/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const data = await res.json();
  if (!res.ok) {
    showBanner(data.error || 'Incorrect PIN', true);
    return;
  }
  state.vaultUnlocked = true;
  showBanner('Private Vault unlocked.');
  renderFiles();
}

async function handleFilesSelected(fileList) {
  if (!fileList || fileList.length === 0) return;

  const wifiOnly = document.getElementById('wifiOnlyToggle').checked;
  if (wifiOnly && navigator.connection && navigator.connection.type === 'cellular') {
    showBanner('Wi-Fi Only mode is enabled. Connect to Wi-Fi to offload files.', true);
    return;
  }

  const folder = document.getElementById('uploadFolderSelect').value;
  const isVaultLocked =
    document.getElementById('vaultLockToggle').checked || folder === 'Private Vault';

  const statusBox = document.getElementById('uploadStatusBox');
  const statusText = document.getElementById('uploadStatusText');
  const pctText = document.getElementById('uploadPercentText');
  const progressBar = document.getElementById('uploadProgressBar');

  statusBox.classList.remove('hidden');

  for (const file of Array.from(fileList)) {
    try {
      statusText.textContent = `Verifying SHA-256 fingerprint for "${file.name}"...`;
      pctText.textContent = 'Checking';
      progressBar.style.width = '15%';

      const sha256 = await computeFileSha256(file);

      const preRes = await fetch('/api/files/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sha256,
          sizeBytes: file.size,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          folder,
          isVaultLocked
        })
      });

      const preData = await preRes.json();
      if (!preRes.ok) {
        showBanner(preData.error || 'Upload preflight failed', true);
        continue;
      }

      if (preData.instantMatch) {
        progressBar.style.width = '100%';
        pctText.textContent = '100% (0 MB Data)';
        statusText.textContent = `Instant Zero-Data Match for "${file.name}"`;
        state.user = preData.user;
        state.files.unshift(preData.file);
        renderCardHeader();
        renderFiles();
        showBanner(
          `Instant Zero-Data Match: "${file.name}" (${formatBytes(
            file.size
          )}) added in 0.1s using 0 MB data.`
        );
        continue;
      }

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files/upload');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('x-file-folder', encodeURIComponent(folder));
        xhr.setRequestHeader('x-file-sha256', sha256);
        xhr.setRequestHeader('x-file-vault', String(isVaultLocked));

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = `${pct}%`;
            pctText.textContent = `${pct}%`;
            statusText.textContent = `Offloading "${file.name}" (${formatBytes(
              e.loaded
            )} of ${formatBytes(e.total)})...`;
          }
        };

        xhr.onload = () => {
          try {
            const response = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
              state.user = response.user;
              state.files.unshift(response.file);
              renderCardHeader();
              renderFiles();
              showBanner(
                `"${file.name}" verified & stored. You can now safely delete the local copy from your device.`
              );
              resolve(response);
            } else {
              showBanner(response.error || 'Upload failed', true);
              reject(new Error(response.error));
            }
          } catch (err) {
            reject(err);
          }
        };

        xhr.onerror = () => reject(new Error('Network error during file upload'));
        xhr.send(file);
      });
    } catch (err) {
      showBanner(err.message || 'Upload error', true);
    }
  }

  setTimeout(() => {
    statusBox.classList.add('hidden');
  }, 2200);
}

async function openStreamModal(fileId) {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;

  const modal = document.getElementById('streamModal');
  const title = document.getElementById('streamModalTitle');
  const body = document.getElementById('streamModalBody');
  const hashLabel = document.getElementById('streamModalHash');
  const downloadBtn = document.getElementById('streamModalDownloadBtn');

  title.textContent = `${file.name} (${formatBytes(file.sizeBytes)})`;
  hashLabel.textContent = `SHA-256: ${file.sha256.slice(0, 24)}...`;
  downloadBtn.href = file.downloadUrl;
  downloadBtn.setAttribute('download', file.name);

  const mime = file.mimeType || '';

  if (mime.startsWith('video/')) {
    body.innerHTML = `
      <video controls autoplay playsinline style="width: 100%; max-height: 62vh; border-radius: 10px; background: #000;" src="${file.streamUrl}"></video>
      <p class="helper-caption" style="margin-top: 0.65rem;">
        Streaming via HTTP 206 Byte-Range chunks — 0 Bytes used on your local drive.
      </p>
    `;
  } else if (mime.startsWith('audio/')) {
    body.innerHTML = `
      <div style="text-align: center; padding: 1.75rem; background: var(--bg-canvas); border: 1px solid var(--border-hairline); border-radius: 12px;">
        <h4 style="margin-bottom: 1rem;">${escapeHtml(file.name)}</h4>
        <audio controls autoplay style="width: 100%;" src="${file.streamUrl}"></audio>
      </div>
    `;
  } else if (mime.startsWith('image/')) {
    body.innerHTML = `
      <div style="text-align: center;">
        <img src="${file.streamUrl}" alt="${escapeHtml(
          file.name
        )}" style="max-width: 100%; max-height: 62vh; border-radius: 10px;" />
      </div>
    `;
  } else if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('javascript') ||
    mime.includes('python') ||
    file.name.endsWith('.md') ||
    file.name.endsWith('.py') ||
    file.name.endsWith('.js') ||
    file.name.endsWith('.ts')
  ) {
    body.innerHTML = `<p class="helper-caption">Streaming file contents...</p>`;
    modal.showModal();
    const res = await fetch(file.streamUrl);
    const text = await res.text();
    body.innerHTML = `<pre class="code-preview-pre"><code>${escapeHtml(text)}</code></pre>`;
    return;
  } else {
    body.innerHTML = `
      <div style="text-align: center; padding: 2rem;">
        <h4>File Stored Safely on Memory Card</h4>
        <p class="helper-caption" style="margin: 0.45rem 0 1.2rem;">
          Size: ${formatBytes(file.sizeBytes)} · SHA-256 Verified
        </p>
        <a href="${file.downloadUrl}" class="btn btn-primary" download="${escapeHtml(file.name)}">
          Download File
        </a>
      </div>
    `;
  }

  modal.showModal();
}

function renderPlansAndPayments() {
  const plansGrid = document.getElementById('plansGrid');
  const planList = Object.values(state.plans);

  plansGrid.innerHTML = planList
    .map((plan) => {
      const isCurrent = state.user && state.user.planId === plan.id;
      const isPopular = plan.id === 'standard';
      return `
        <div class="plan-card ${isPopular ? 'popular' : ''}">
          <div>
            <span class="eyebrow-tag ${isPopular ? 'text-emerald' : ''}">${escapeHtml(
              plan.badge
            )}</span>
            <h3 style="font-size: 1.15rem; margin-top: 0.3rem;">${escapeHtml(plan.name)}</h3>
            <div class="plan-price">${escapeHtml(plan.priceLabel)}</div>
            <ul class="plan-features">
              ${plan.features.map((f) => `<li>✓ ${escapeHtml(f)}</li>`).join('')}
            </ul>
          </div>
          <div>
            ${
              isCurrent
                ? `<button class="btn btn-outline btn-block" disabled>Current Plan</button>`
                : plan.priceNaira === 0
                  ? `<button class="btn btn-ghost btn-block" disabled>Included</button>`
                  : `<button class="btn btn-primary btn-block" data-upgrade-plan="${plan.id}">
                      Upgrade to ${escapeHtml(plan.quotaLabel)} (₦${plan.priceNaira})
                    </button>`
            }
          </div>
        </div>
      `;
    })
    .join('');

  const historyEl = document.getElementById('userPaymentsHistory');
  if (!state.payments || state.payments.length === 0) {
    historyEl.innerHTML = `<p class="helper-caption">No transfers submitted yet.</p>`;
  } else {
    historyEl.innerHTML = state.payments
      .map(
        (p) => `
      <div class="claim-item">
        <div>
          <strong>${escapeHtml(p.planName)} (${escapeHtml(p.quotaLabel)}) — ₦${p.amountNaira}</strong>
          <div class="file-meta">
            Ref: <code>${p.reference}</code> · ${escapeHtml(p.channel)}
            ${p.receiptNumber ? ` · Receipt: <code>${p.receiptNumber}</code>` : ''}
          </div>
        </div>
        <span class="safe-badge" style="${
          p.status === 'APPROVED'
            ? ''
            : p.status === 'REJECTED'
              ? 'background: #fef2f2; color: #dc2626;'
              : 'background: #fef3c7; color: #b45309;'
        }">
          ${p.status}
        </span>
      </div>
    `
      )
      .join('');
  }

  renderAdminPendingClaims();
}

async function fetchPendingClaims() {
  try {
    const res = await fetch('/api/payments/pending');
    const data = await res.json();
    state.pendingAdminClaims = data.pending || [];
    renderAdminPendingClaims();
  } catch {
    // Ignore
  }
}

function renderAdminPendingClaims() {
  const container = document.getElementById('adminPendingClaimsList');
  if (!container) return;
  if (!state.pendingAdminClaims || state.pendingAdminClaims.length === 0) {
    container.innerHTML = `<p class="helper-caption">No pending transfer claims waiting for approval.</p>`;
    return;
  }

  container.innerHTML = state.pendingAdminClaims
    .map(
      (c) => `
    <div class="claim-item">
      <div>
        <strong>${escapeHtml(c.reference)}: ₦${c.amountNaira} (${escapeHtml(c.quotaLabel)})</strong>
        <div class="file-meta">
          From <strong>${escapeHtml(c.senderName)}</strong> via ${escapeHtml(c.channel)}
        </div>
      </div>
      <div style="display: flex; gap: 0.4rem;">
        <button class="btn btn-primary btn-xs" data-resolve-id="${c.id}" data-resolve-action="APPROVE">
          Approve
        </button>
        <button class="btn btn-danger btn-xs" data-resolve-id="${c.id}" data-resolve-action="REJECT">
          Reject
        </button>
      </div>
    </div>
  `
    )
    .join('');
}

function connectLiveEvents() {
  const es = new EventSource('/api/events/stream');
  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'PAYMENT_RESOLVED') {
        state.user = data.user;
        const idx = state.payments.findIndex((p) => p.id === data.payment.id);
        if (idx >= 0) state.payments[idx] = data.payment;
        else state.payments.unshift(data.payment);

        await fetchPendingClaims();
        renderCardHeader();
        renderPlansAndPayments();

        if (data.payment.status === 'APPROVED') {
          showBanner(
            `Payment Approved (${data.payment.receiptNumber}): Your Memory Card is now expanded to ${data.payment.quotaLabel}!`
          );
        } else {
          showBanner(`Payment claim ${data.payment.reference} was declined.`, true);
        }
      } else if (data.type === 'FILES_UPDATED') {
        await loadSession();
      }
    } catch {
      // Ignore heartbeat
    }
  };
}

function connectP2PRoom() {
  const roomCode = document.getElementById('p2pRoomInput').value.trim() || '2026';
  const deviceInput = document.getElementById('p2pDeviceName');
  const defaultDevice = navigator.platform ? `${navigator.platform}` : 'CardNG Device';
  const deviceName = deviceInput.value.trim() || defaultDevice;
  deviceInput.value = deviceName;

  if (state.p2pEventSource) {
    state.p2pEventSource.close();
  }

  state.p2pRoomCode = roomCode;
  const url = `/api/p2p/room/${encodeURIComponent(roomCode)}?peerId=${encodeURIComponent(
    state.p2pPeerId
  )}&device=${encodeURIComponent(deviceName)}`;

  const es = new EventSource(url);
  state.p2pEventSource = es;

  document.getElementById('p2pRoomStatus').innerHTML = `
    Connected to Room <strong>#${escapeHtml(roomCode)}</strong> as <strong>${escapeHtml(
      deviceName
    )}</strong> (0 MB Internet Data Mode)
  `;
  document.getElementById('btnBeamP2PFile').disabled = false;

  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'PEERS_UPDATED') {
        const peersEl = document.getElementById('p2pPeersList');
        const others = msg.peers.filter((p) => p.peerId !== state.p2pPeerId);
        if (others.length === 0) {
          peersEl.innerHTML = `<p class="helper-caption">Waiting for another device or browser tab to join Room <strong>#${escapeHtml(
            roomCode
          )}</strong>...</p>`;
        } else {
          peersEl.innerHTML = others
            .map(
              (p) => `
            <div class="claim-item">
              <span><strong>${escapeHtml(p.deviceName)}</strong></span>
              <span class="safe-badge">Connected on Local Wi-Fi</span>
            </div>
          `
            )
            .join('');
        }
      } else if (msg.type === 'P2P_FILE_BEAM') {
        const receivedBox = document.getElementById('p2pReceivedBox');
        const item = document.createElement('div');
        item.className = 'claim-item';
        item.style.marginTop = '0.6rem';
        item.innerHTML = `
          <div>
            <strong>Received: ${escapeHtml(msg.fileName)}</strong>
            <div class="file-meta">${formatBytes(msg.fileSize)} · From ${escapeHtml(
              msg.senderDevice
            )} (0 MB Data)</div>
          </div>
          <a href="${msg.dataUrl}" download="${escapeHtml(
            msg.fileName
          )}" class="btn btn-primary btn-xs">Save</a>
        `;
        receivedBox.prepend(item);
        showBanner(`Received "${msg.fileName}" via Local Wi-Fi Beam (0 MB data used).`);
      }
    } catch {
      // Ignore
    }
  };
}

async function beamLocalP2PFile(file) {
  if (!file || !state.p2pRoomCode) return;
  if (file.size > 7 * 1024 * 1024) {
    showBanner('Please select a file under 7 MB for instant browser beam.', true);
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    await fetch('/api/p2p/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: state.p2pRoomCode,
        senderPeerId: state.p2pPeerId,
        senderDevice: document.getElementById('p2pDeviceName').value || 'CardNG Device',
        type: 'P2P_FILE_BEAM',
        fileName: file.name,
        fileSize: file.size,
        dataUrl: reader.result
      })
    });
    showBanner(`Beamed "${file.name}" to Room #${state.p2pRoomCode} using 0 MB data.`);
  };
  reader.readAsDataURL(file);
}

async function loadSession() {
  const res = await fetch('/api/session');
  const data = await res.json();
  state.user = data.user;
  state.files = data.files || [];
  state.payments = data.payments || [];
  state.plans = data.plans || {};
  state.merchant = data.merchant || {};
  state.webdavUrl = data.webdavUrl || '';
  state.lanUrl = data.lanUrl || '';

  if (state.merchant.opay) {
    document.getElementById('opayNumberText').textContent = state.merchant.opay.accountNumber;
    document.getElementById('opayNameText').textContent = state.merchant.opay.accountName;
  }
  if (state.merchant.palmpay) {
    document.getElementById('palmpayNumberText').textContent = state.merchant.palmpay.accountNumber;
    document.getElementById('palmpayNameText').textContent = state.merchant.palmpay.accountName;
  }

  renderCardHeader();
  renderFiles();
  renderPlansAndPayments();
  await fetchPendingClaims();
}

window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  await loadSession();
  connectLiveEvents();

  // Sidebar Navigation
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view, btn.dataset.folder || null);
    });
  });

  document.getElementById('btnSidebarUpgrade').addEventListener('click', () => {
    switchView('view-upgrade');
  });

  // Primary Upload & Dropzone
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');

  document.getElementById('btnPrimaryUpload').addEventListener('click', () => {
    switchView('view-files');
    fileInput.click();
  });

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    handleFilesSelected(e.target.files);
    fileInput.value = '';
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFilesSelected(e.dataTransfer.files);
  });

  // Seed Demo Files
  document.getElementById('btnSeedDemoFiles').addEventListener('click', async () => {
    const res = await fetch('/api/files/seed-demo', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      state.user = data.user;
      state.files = [...data.files, ...state.files];
      renderCardHeader();
      renderFiles();
      showBanner('Sample audio and developer files added to your Memory Card.');
    }
  });

  // Search
  document.getElementById('fileSearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    if (state.activeView !== 'view-files') {
      switchView('view-files');
    } else {
      renderFiles();
    }
  });

  // File Card Actions
  document.getElementById('filesGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const fileId = btn.dataset.id;

    if (action === 'stream') {
      openStreamModal(fileId);
    } else if (action === 'toggle-vault') {
      const file = state.files.find((f) => f.id === fileId);
      if (!file) return;
      const res = await fetch(`/api/files/${fileId}/vault`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isVaultLocked: !file.isVaultLocked })
      });
      const data = await res.json();
      if (res.ok) {
        const idx = state.files.findIndex((f) => f.id === fileId);
        if (idx >= 0) state.files[idx] = data.file;
        renderFiles();
        showBanner(
          data.file.isVaultLocked
            ? `Moved "${data.file.name}" to Private Vault.`
            : `Removed "${data.file.name}" from Private Vault.`
        );
      }
    } else if (action === 'delete') {
      const res = await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        state.files = state.files.filter((f) => f.id !== fileId);
        state.user = data.user;
        renderCardHeader();
        renderFiles();
        showBanner('File deleted from Memory Card.');
      }
    }
  });

  // Stream Modal Close
  const streamModal = document.getElementById('streamModal');
  document.getElementById('btnCloseStreamModal').addEventListener('click', () => {
    document.getElementById('streamModalBody').innerHTML = '';
    streamModal.close();
  });

  // WebDAV Copy
  document.getElementById('btnCopyWebdav').addEventListener('click', () => {
    navigator.clipboard.writeText(state.webdavUrl);
    showBanner('Personal WebDAV Drive Link copied to clipboard.');
  });

  // Upgrade Plan Selection
  const paymentModal = document.getElementById('paymentModal');
  document.getElementById('plansGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-upgrade-plan]');
    if (!btn) return;
    const plan = state.plans[btn.dataset.upgradePlan];
    if (!plan) return;

    document.getElementById('paySelectedPlanId').value = plan.id;
    document.getElementById('payModalTitle').textContent = `Upgrade to ${plan.name}`;
    document.getElementById('payModalAmount').textContent = `₦${plan.priceNaira}`;
    document.getElementById('payModalPlanBadge').textContent = `${plan.name} (${plan.quotaLabel})`;
    paymentModal.showModal();
  });

  document.getElementById('btnClosePayModal').addEventListener('click', () => paymentModal.close());

  document.getElementById('btnCopyOpay').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('opayNumberText').textContent);
    showBanner('OPay account number copied.');
  });

  document.getElementById('btnCopyPalmpay').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('palmpayNumberText').textContent);
    showBanner('PalmPay account number copied.');
  });

  document.getElementById('paymentClaimForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const planId = document.getElementById('paySelectedPlanId').value;
    const channel = document.getElementById('payChannelSelect').value;
    const senderName = document.getElementById('paySenderNameInput').value;

    const res = await fetch('/api/payments/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, channel, senderName })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Could not submit payment claim', true);
      return;
    }

    paymentModal.close();
    state.payments.unshift(data.payment);
    await fetchPendingClaims();
    renderPlansAndPayments();
    showBanner(
      `Transfer claim ${data.payment.reference} submitted! Click "Approve" in the Telegram Simulator below to test instant unlock.`
    );
  });

  document.getElementById('adminPendingClaimsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-resolve-id]');
    if (!btn) return;
    await fetch(`/api/payments/${btn.dataset.resolveId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: btn.dataset.resolveAction })
    });
  });

  // Lock Card Modal
  const lockModal = document.getElementById('lockCardModal');
  document.getElementById('btnOpenLockModal').addEventListener('click', () => lockModal.showModal());
  document.getElementById('btnCloseLockModal').addEventListener('click', () => lockModal.close());

  document.getElementById('lockCardForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const displayName = document.getElementById('lockNameInput').value;
    const phone = document.getElementById('lockPhoneInput').value;
    const pin = document.getElementById('lockPinInput').value;

    const res = await fetch('/api/auth/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, phone, pin })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Could not lock card', true);
      return;
    }
    state.user = data.user;
    lockModal.close();
    renderCardHeader();
    showBanner(data.message);
  });

  // Restore Card Modal
  const restoreModal = document.getElementById('restoreCardModal');
  document
    .getElementById('btnOpenRestoreModal')
    .addEventListener('click', () => restoreModal.showModal());
  document
    .getElementById('btnCloseRestoreModal')
    .addEventListener('click', () => restoreModal.close());

  document.getElementById('restoreCardForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('restorePhoneInput').value;
    const pin = document.getElementById('restorePinInput').value;

    const res = await fetch('/api/auth/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, pin })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Invalid credentials', true);
      return;
    }
    restoreModal.close();
    await loadSession();
    showBanner(data.message);
  });

  // Local Wi-Fi P2P
  document.getElementById('btnConnectP2P').addEventListener('click', connectP2PRoom);
  const p2pFileInput = document.getElementById('p2pFileInput');
  document.getElementById('btnBeamP2PFile').addEventListener('click', () => p2pFileInput.click());
  p2pFileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) beamLocalP2PFile(e.target.files[0]);
    p2pFileInput.value = '';
  });
});
