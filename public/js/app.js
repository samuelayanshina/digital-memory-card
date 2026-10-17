const state = {
  user: null,
  files: [],
  payments: [],
  breakdown: {},
  auditLogs: [],
  pendingAdminClaims: [],
  plans: {},
  merchant: {},
  webdavUrl: '',
  lanUrl: '',
  activeView: 'view-files',
  activeFolder: 'ALL',
  searchQuery: '',
  vaultUnlocked: false,
  activeStudioFileId: null,
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

async function computeFileSliceSha256(file, offset = 0, length = 64) {
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, file.size - 1)));
  const safeEnd = Math.min(file.size, safeOffset + length);
  const sliceBuf = await file.slice(safeOffset, safeEnd).arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', sliceBuf);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return {
    offset: safeOffset,
    length: safeEnd - safeOffset,
    hash: hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  };
}

function isEditableTextFile(file) {
  const mime = file.mimeType || '';
  const name = (file.name || '').toLowerCase();
  return (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('javascript') ||
    mime.includes('python') ||
    name.endsWith('.md') ||
    name.endsWith('.py') ||
    name.endsWith('.js') ||
    name.endsWith('.ts') ||
    name.endsWith('.json') ||
    name.endsWith('.txt')
  );
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
      heading.textContent =
        folder === 'ALL' ? 'All Files' : folder === 'TRASH' ? 'Trash Bin' : folder;
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
  } else if (viewId === 'view-doctor') {
    runMacStorageDoctorScan();
  } else if (viewId === 'view-security') {
    renderSecurityAudit();
  }
}

function renderStorageBreakdown() {
  const quota = (state.user && state.user.quotaBytes) || 1;
  const bd = state.breakdown || {};
  const scaleSeg = (bytes) => {
    if (!bytes || bytes <= 0) return 0;
    return Math.min(100, Math.max(1.5, (bytes / quota) * 100));
  };

  const setSeg = (segId, valId, bytes) => {
    const segEl = document.getElementById(segId);
    const valEl = document.getElementById(valId);
    if (segEl) segEl.style.width = `${scaleSeg(bytes)}%`;
    if (valEl) valEl.textContent = formatBytes(bytes || 0);
  };

  setSeg('bdSegMedia', 'bdValMedia', bd.mediaBytes);
  setSeg('bdSegPhotos', 'bdValPhotos', bd.photoBytes);
  setSeg('bdSegDev', 'bdValDev', (bd.devBytes || 0) + (bd.otherBytes || 0));
  setSeg('bdSegDocs', 'bdValDocs', bd.docBytes);
  setSeg('bdSegVault', 'bdValVault', bd.vaultBytes);
  setSeg('bdSegTrash', 'bdValTrash', bd.trashBytes);
}

function renderSecurityAudit() {
  const heading = document.getElementById('secVaultStatusHeading');
  const caption = document.getElementById('secVaultStatusCaption');
  if (heading && caption) {
    if (state.vaultUnlocked) {
      heading.textContent = 'Private Vault Unlocked (Active Grant)';
      caption.textContent =
        'Cryptographic HMAC-SHA256 PIN grant is active for this session (auto-expires after 30 minutes).';
    } else {
      heading.textContent = 'Private Vault Locked';
      caption.textContent =
        'Vault files require an HMAC-SHA256 signed PIN token before the server will stream or share them.';
    }
  }

  const diskHeading = document.getElementById('secDiskHealthHeading');
  if (diskHeading && state.diskHealth) {
    diskHeading.textContent = `Two-Tier Storage (${state.diskHealth.usedPercent}% Host Disk Used)`;
  }

  const listEl = document.getElementById('securityAuditList');
  if (!listEl) return;
  const logs = state.auditLogs || [];
  if (logs.length === 0) {
    listEl.innerHTML = `<p class="helper-caption">No security events logged yet. Lock your card, unlock your vault, or share a file to generate cryptographic audit entries.</p>`;
    return;
  }

  listEl.innerHTML = logs
    .map((entry) => {
      const badgeStyle =
        entry.severity === 'WARN'
          ? 'background: #fef2f2; color: #dc2626;'
          : entry.severity === 'SUCCESS'
            ? ''
            : 'background: #f1f5f9; color: #475569;';
      return `
      <div class="claim-item">
        <div>
          <strong>${escapeHtml(entry.action)}</strong>
          <div class="file-meta">${escapeHtml(entry.detail)}</div>
        </div>
        <div style="text-align: right;">
          <span class="safe-badge" style="${badgeStyle}">${escapeHtml(entry.severity)}</span>
          <div class="file-meta" style="margin-top: 0.25rem;">
            ${new Date(entry.createdAt).toLocaleTimeString()} · IP ${escapeHtml(entry.ip)}
          </div>
        </div>
      </div>
    `;
    })
    .join('');
}

function renderCardHeader() {
  const user = state.user;
  if (!user) return;

  const plan = state.plans[user.planId] || {
    badge: 'FREE STARTER',
    quotaLabel: formatBytes(user.quotaBytes)
  };
  const qs = user.quotaStatus || {};
  let badgeText = plan.badge || user.planName.toUpperCase();
  if (qs.isReadOnlyGraceMode) {
    badgeText = 'READ-ONLY GRACE MODE';
  } else if (qs.daysRemaining && user.planId !== 'free') {
    badgeText = `${badgeText} • ${qs.daysRemaining}D LEFT`;
  }
  document.getElementById('cardPlanBadge').textContent = badgeText;
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
  const p2pLanEl = document.getElementById('p2pLanUrlDisplay');
  if (p2pLanEl) p2pLanEl.textContent = state.lanUrl;
  const qrImg = document.getElementById('lanQrCodeImg');
  if (qrImg && state.lanUrl) {
    qrImg.src = `/api/system/qr-svg?text=${encodeURIComponent(state.lanUrl)}`;
  }
  renderStorageBreakdown();
}

function renderFiles() {
  const grid = document.getElementById('filesGrid');
  const activeFilesCount = state.files.filter((f) => !f.isTrashed).length;
  const trashedFilesCount = state.files.filter((f) => f.isTrashed).length;

  document.getElementById('fileCountPill').textContent = String(activeFilesCount);
  const trashPill = document.getElementById('trashCountPill');
  if (trashPill) trashPill.textContent = String(trashedFilesCount);

  const isTrashView = state.activeFolder === 'TRASH';
  const trashBanner = document.getElementById('emptyTrashBanner');
  const uploadBarWrap = document.getElementById('uploadBarWrap');
  if (trashBanner) trashBanner.classList.toggle('hidden', !isTrashView);
  if (uploadBarWrap) uploadBarWrap.classList.toggle('hidden', isTrashView);

  if (state.activeFolder === 'Private Vault' && !state.vaultUnlocked) {
    grid.innerHTML = `
      <div class="surface-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem;">
        <h3 style="margin-bottom: 0.35rem;">Private Vault Locked</h3>
        <p class="helper-caption" style="max-width: 400px; margin: 0 auto 1.25rem;">
          Enter your 4-digit security PIN (default is <code>0000</code> on guest cards) to issue a cryptographic unlock token and view or stream vault files.
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
    if (isTrashView) {
      if (!file.isTrashed) return false;
    } else {
      if (file.isTrashed) return false;
      if (state.activeFolder === 'Private Vault') {
        if (!file.isVaultLocked) return false;
      } else if (state.activeFolder !== 'ALL') {
        if (file.isVaultLocked || file.folder !== state.activeFolder) return false;
      } else {
        if (file.isVaultLocked && !state.vaultUnlocked) return false;
      }
    }

    if (state.searchQuery) {
      return file.name.toLowerCase().includes(state.searchQuery.toLowerCase());
    }
    return true;
  });

  if (filtered.length === 0) {
    if (isTrashView) {
      grid.innerHTML = `
        <div class="surface-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem;">
          <h3 style="font-size: 1.05rem; margin-bottom: 0.35rem;">Trash Bin is Clean</h3>
          <p class="helper-caption" style="max-width: 420px; margin: 0 auto;">
            Deleted files stay here until you empty the trash, protecting you from accidental data loss after offloading from your phone or Mac.
          </p>
        </div>
      `;
      return;
    }

    grid.innerHTML = `
      <div class="surface-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem;">
        <h3 style="font-size: 1.05rem; margin-bottom: 0.35rem;">Your Digital Memory Card is Ready</h3>
        <p class="helper-caption" style="max-width: 440px; margin: 0 auto 1.15rem;">
          Drop any movie, photo, or code archive into the bar above to offload it from your device — or load sample files to test instant streaming and code execution.
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
    .map((file) => {
      const editable = isEditableTextFile(file);
      return `
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
        ${
          file.isTrashed
            ? `
          <button class="btn btn-primary btn-xs" data-action="restore" data-id="${file.id}">
            Restore File
          </button>
          <button class="btn btn-danger btn-xs" style="margin-left: auto;" data-action="delete-forever" data-id="${file.id}">
            Delete Forever
          </button>
        `
            : `
          <button class="btn btn-primary btn-xs" data-action="stream" data-id="${file.id}">
            ${editable ? 'Studio / Run' : 'Stream'}
          </button>
          <button class="btn btn-outline btn-xs" data-action="share" data-id="${file.id}" title="Share with a friend using 0 MB internet data">
            Share
          </button>
          <button class="btn btn-ghost btn-xs" data-action="rename" data-id="${file.id}">
            Rename
          </button>
          <button class="btn btn-ghost btn-xs" data-action="toggle-vault" data-id="${file.id}">
            ${file.isVaultLocked ? 'Unvault' : 'Vault'}
          </button>
          <button class="btn btn-danger btn-xs" style="margin-left: auto;" data-action="trash" data-id="${file.id}">
            Trash
          </button>
        `
        }
      </div>
    </article>
  `;
    })
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
  if (data.auditLogs) state.auditLogs = data.auditLogs;
  showBanner('Private Vault unlocked with signed cryptographic token.');
  renderFiles();
}

async function tryCompressFileToGzipBlob(file) {
  if (typeof CompressionStream === 'undefined' || file.size > 80 * 1024 * 1024) {
    return null;
  }
  try {
    const compressedStream = file.stream().pipeThrough(new CompressionStream('gzip'));
    const compressedBlob = await new Response(compressedStream).blob();
    if (compressedBlob.size < file.size * 0.96) {
      return compressedBlob;
    }
    return null;
  } catch {
    return null;
  }
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
  const useGzipSaver = document.getElementById('gzipSaverToggle')?.checked ?? true;

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
      const sliceProof = await computeFileSliceSha256(file, 0, 64);

      const preRes = await fetch('/api/files/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sha256,
          sizeBytes: file.size,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          folder,
          isVaultLocked,
          sliceProof
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

      let payloadToSend = file;
      let isGzipUpload = false;
      if (useGzipSaver) {
        statusText.textContent = `Compressing "${file.name}" on device to save mobile data...`;
        const compressed = await tryCompressFileToGzipBlob(file);
        if (compressed) {
          payloadToSend = compressed;
          isGzipUpload = true;
        }
      }

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files/upload');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('x-file-folder', encodeURIComponent(folder));
        xhr.setRequestHeader('x-file-sha256', sha256);
        xhr.setRequestHeader('x-file-vault', String(isVaultLocked));
        if (isGzipUpload) {
          xhr.setRequestHeader('x-upload-encoding', 'gzip');
        }

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = `${pct}%`;
            pctText.textContent = `${pct}%`;
            statusText.textContent = `Offloading "${file.name}" (${formatBytes(
              e.loaded
            )} of ${formatBytes(e.total)}${isGzipUpload ? ' compressed' : ''})...`;
          }
        };

        xhr.onload = () => {
          try {
            const response = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
              state.user = response.user;
              if (response.breakdown) state.breakdown = response.breakdown;
              state.files.unshift(response.file);
              renderCardHeader();
              renderFiles();
              const savedNote =
                response.compressionSavedBytes > 0
                  ? ` (Saved ${formatBytes(response.compressionSavedBytes)} of mobile data via GZIP!)`
                  : '';
              showBanner(
                `"${file.name}" verified & stored${savedNote}. Safe to delete local copy from your device.`
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
        xhr.send(payloadToSend);
      });
    } catch (err) {
      showBanner(err.message || 'Upload error', true);
    }
  }

  setTimeout(() => {
    statusBox.classList.add('hidden');
  }, 2200);
}

// Open HTTP 206 Streaming Theater & Interactive Cloud Code Studio
async function openStreamModal(fileId) {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;

  state.activeStudioFileId = file.id;

  const modal = document.getElementById('streamModal');
  const title = document.getElementById('streamModalTitle');
  const body = document.getElementById('streamModalBody');
  const hashLabel = document.getElementById('streamModalHash');
  const downloadBtn = document.getElementById('streamModalDownloadBtn');
  const runBtn = document.getElementById('btnRunCloudCode');
  const saveBtn = document.getElementById('btnSaveCloudCode');

  title.textContent = `${file.name} (${formatBytes(file.sizeBytes)})`;
  hashLabel.textContent = `SHA-256: ${file.sha256.slice(0, 24)}...`;
  downloadBtn.href = file.downloadUrl;
  downloadBtn.setAttribute('download', file.name);

  runBtn.classList.add('hidden');
  saveBtn.classList.add('hidden');

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
  } else if (isEditableTextFile(file)) {
    body.innerHTML = `<p class="helper-caption">Opening Cloud Studio directly from Memory Card...</p>`;
    modal.showModal();
    const res = await fetch(file.streamUrl);
    const text = await res.text();

    saveBtn.classList.remove('hidden');
    if (file.name.endsWith('.js')) {
      runBtn.classList.remove('hidden');
    }

    body.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <textarea id="cloudStudioTextarea" class="input mono" rows="12" style="width: 100%; font-size: 0.82rem; line-height: 1.55;">${escapeHtml(
          text
        )}</textarea>
        <div id="cloudStudioOutputBox" class="status-callout mono hidden" style="white-space: pre-wrap; max-height: 180px; overflow-y: auto;"></div>
      </div>
    `;
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

// RunMacStorageDoctorScan
async function runMacStorageDoctorScan() {
  const grid = document.getElementById('doctorHotspotsGrid');
  grid.innerHTML = `<p class="helper-caption">Scanning macOS developer cache hotspots...</p>`;

  try {
    const res = await fetch('/api/mac-doctor/scan');
    const data = await res.json();

    document.getElementById('docHostLabel').textContent = `${data.hostname} (${data.platform})`;
    document.getElementById('docRamLabel').textContent = `${formatBytes(
      data.freeMemBytes
    )} Free / ${formatBytes(data.totalMemBytes)} Total`;

    grid.innerHTML = (data.hotspots || [])
      .map(
        (h) => `
      <div class="surface-card step-card">
        <div class="step-os-tag">${h.exists ? 'Detected on Mac' : 'Clean / Not Present'}</div>
        <h3>${escapeHtml(h.title)}</h3>
        <p class="helper-caption" style="margin: 0.35rem 0 0.75rem;">
          ${escapeHtml(h.recommendation)}
        </p>
        <div style="font-size: 0.82rem; margin-bottom: 0.75rem;">
          Sampled Size: <strong>${formatBytes(h.sampledBytes)}</strong> (${h.sampledFilesCount} items scanned)
        </div>
        <div class="url-copy-bar" style="margin-bottom: 0;">
          <input type="text" class="url-input" value="${escapeHtml(h.command)}" readonly />
          <button type="button" class="btn btn-outline btn-xs" data-copy-cmd="${escapeHtml(
            h.command
          )}">Copy</button>
        </div>
      </div>
    `
      )
      .join('');
  } catch {
    grid.innerHTML = `<p class="helper-caption">Could not scan host filesystem.</p>`;
  }
}

function openReceiptModal(payment) {
  const modal = document.getElementById('receiptModal');
  document.getElementById('receiptModalNumber').textContent =
    payment.receiptNumber || payment.reference;

  document.getElementById('receiptModalBody').innerHTML = `
    <div style="border: 1px solid var(--border-hairline); border-radius: 12px; padding: 1.25rem; background: var(--bg-canvas);">
      <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 0.85rem; border-bottom: 1px solid var(--border-hairline); margin-bottom: 0.85rem;">
        <div>
          <div style="font-weight: 700; font-size: 1rem;">CardNG Storage Expansion</div>
          <div class="helper-caption">${new Date(
            payment.resolvedAt || payment.createdAt
          ).toLocaleString()}</div>
        </div>
        <span class="status-pill-emerald">PAID & VERIFIED</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 0.55rem; font-size: 0.86rem;">
        <div style="display: flex; justify-content: space-between;">
          <span class="helper-caption">Amount Paid:</span>
          <strong>₦${Number(payment.amountNaira).toLocaleString()}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span class="helper-caption">Plan Unlocked:</span>
          <strong>${escapeHtml(payment.planName)} (${escapeHtml(payment.quotaLabel)})</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span class="helper-caption">Payment Channel:</span>
          <strong>${escapeHtml(payment.channel)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span class="helper-caption">Sender Name:</span>
          <strong>${escapeHtml(payment.senderName)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span class="helper-caption">Memory Card Serial:</span>
          <code class="mono">${escapeHtml(payment.cardSerial)}</code>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span class="helper-caption">Transfer Reference:</span>
          <code class="mono">${escapeHtml(payment.reference)}</code>
        </div>
      </div>
    </div>
  `;
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
        <div style="display: flex; align-items: center; gap: 0.45rem;">
          ${
            p.status === 'APPROVED'
              ? `<button type="button" class="btn btn-outline btn-xs" data-view-receipt="${p.id}">Receipt</button>`
              : ''
          }
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
  es.onopen = () => {
    if (!state.user) {
      loadSession().catch(() => {});
    }
  };
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
          openReceiptModal(data.payment);
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
  const roomInput = document.getElementById('p2pRoomInput');
  const roomCode = (roomInput ? roomInput.value.trim() : '') || '2026';
  const deviceInput = document.getElementById('p2pDeviceName');
  const defaultDevice = navigator.platform ? `${navigator.platform}` : 'CardNG Device';
  const deviceName = (deviceInput ? deviceInput.value.trim() : '') || defaultDevice;
  if (deviceInput) deviceInput.value = deviceName;

  if (state.p2pEventSource) {
    state.p2pEventSource.close();
  }

  state.p2pRoomCode = roomCode;
  const url = `/api/p2p/room/${encodeURIComponent(roomCode)}?peerId=${encodeURIComponent(
    state.p2pPeerId
  )}&device=${encodeURIComponent(deviceName)}`;

  const es = new EventSource(url);
  state.p2pEventSource = es;

  const statusEl = document.getElementById('p2pRoomStatus');
  if (statusEl) {
    statusEl.innerHTML = `
      Connected to Room <strong>#${escapeHtml(roomCode)}</strong> as <strong>${escapeHtml(
        deviceName
      )}</strong> (0 MB Internet Data Mode)
    `;
  }
  const beamBtn = document.getElementById('btnBeamP2PFile');
  if (beamBtn) beamBtn.disabled = false;

  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'PEERS_UPDATED') {
        const peersEl = document.getElementById('p2pPeersList');
        if (!peersEl) return;
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
        if (!receivedBox) return;
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
    const devEl = document.getElementById('p2pDeviceName');
    await fetch('/api/p2p/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: state.p2pRoomCode,
        senderPeerId: state.p2pPeerId,
        senderDevice: (devEl && devEl.value) || 'CardNG Device',
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
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.user = data.user;
    state.files = data.files || [];
    state.payments = data.payments || [];
    state.breakdown = data.breakdown || {};
    state.auditLogs = data.auditLogs || [];
    state.vaultUnlocked = Boolean(data.vaultUnlocked);
    state.plans = data.plans || {};
    state.merchant = data.merchant || {};
    state.webdavUrl = data.webdavUrl || '';
    state.lanUrl = data.lanUrl || '';
    state.diskHealth = data.diskHealth || null;

    const opayNum = document.getElementById('opayNumberText');
    const opayName = document.getElementById('opayNameText');
    if (state.merchant.opay && opayNum && opayName) {
      opayNum.textContent = state.merchant.opay.accountNumber;
      opayName.textContent = state.merchant.opay.accountName;
    }
    const palmNum = document.getElementById('palmpayNumberText');
    const palmName = document.getElementById('palmpayNameText');
    if (state.merchant.palmpay && palmNum && palmName) {
      palmNum.textContent = state.merchant.palmpay.accountNumber;
      palmName.textContent = state.merchant.palmpay.accountName;
    }

    renderCardHeader();
    renderFiles();
    renderPlansAndPayments();
    renderSecurityAudit();
    await fetchPendingClaims();
  } catch {
    showBanner(
      'Server connection paused — make sure "npm start" is running in your terminal, then click any button.',
      true
    );
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const on = (idOrEl, event, handler) => {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (el) el.addEventListener(event, handler);
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js?v=6')
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }

  // 1. Bind ALL UI & Button Event Listeners FIRST so buttons are 100% responsive immediately
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view, btn.dataset.folder || null);
    });
  });

  on('btnSidebarUpgrade', 'click', () => {
    switchView('view-upgrade');
  });

  // CSP-safe stopPropagation on dropbar controls
  on('dropbarControls', 'click', (e) => e.stopPropagation());

  // Primary Upload & Dropzone
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');

  on('btnPrimaryUpload', 'click', () => {
    switchView('view-files', 'ALL');
    if (fileInput) fileInput.click();
  });

  on(dropZone, 'click', () => {
    if (fileInput) fileInput.click();
  });
  on(fileInput, 'change', (e) => {
    handleFilesSelected(e.target.files);
    fileInput.value = '';
  });

  on(dropZone, 'dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  on(dropZone, 'dragleave', () => dropZone.classList.remove('dragover'));
  on(dropZone, 'drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFilesSelected(e.dataTransfer.files);
  });

  // Seed Demo Files
  on('btnSeedDemoFiles', 'click', async () => {
    try {
      const res = await fetch('/api/files/seed-demo', { method: 'POST' });
      if (res.ok) {
        await loadSession();
        showBanner('Sample audio and runnable developer files added to your Memory Card.');
      }
    } catch {
      showBanner('Server is offline — run "npm start" in your terminal first.', true);
    }
  });

  // Empty Trash Button
  on('btnEmptyTrash', 'click', async () => {
    const res = await fetch('/api/files/trash/empty', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      state.files = state.files.filter((f) => !f.isTrashed);
      state.user = data.user;
      state.breakdown = data.breakdown || state.breakdown;
      renderCardHeader();
      renderFiles();
      showBanner(`Emptied Trash (${data.deletedCount} file(s) permanently purged).`);
    }
  });

  // Refresh Security Audit Log
  on('btnRefreshSecurity', 'click', async () => {
    const res = await fetch('/api/security/audit');
    const data = await res.json();
    if (res.ok) {
      state.auditLogs = data.auditLogs || [];
      state.breakdown = data.breakdown || state.breakdown;
      state.vaultUnlocked = Boolean(data.vaultUnlocked);
      renderSecurityAudit();
      renderStorageBreakdown();
      showBanner('Security audit trail refreshed.');
    }
  });

  // Create New Cloud File Modal
  const createFileModal = document.getElementById('createFileModal');
  on('btnOpenCreateFileModal', 'click', () => createFileModal && createFileModal.showModal());
  on('btnCloseCreateFileModal', 'click', () => createFileModal && createFileModal.close());

  on('createFileForm', 'submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newFileNameInput').value;
    const folder = document.getElementById('newFileFolderSelect').value;
    const content = document.getElementById('newFileContentInput').value;

    const res = await fetch('/api/files/create-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder, content })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Could not create file', true);
      return;
    }
    if (createFileModal) createFileModal.close();
    await loadSession();
    showBanner(`Created "${data.file.name}" directly on your Memory Card (0B local space used).`);
  });

  // Rename or Move File Modal
  const renameFileModal = document.getElementById('renameFileModal');
  on('btnCloseRenameModal', 'click', () => renameFileModal && renameFileModal.close());

  on('renameFileForm', 'submit', async (e) => {
    e.preventDefault();
    const fileId = document.getElementById('renameFileIdInput').value;
    const name = document.getElementById('renameFileNameInput').value;
    const folder = document.getElementById('renameFileFolderSelect').value;

    const res = await fetch(`/api/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Could not update file', true);
      return;
    }
    const idx = state.files.findIndex((f) => f.id === fileId);
    if (idx >= 0) state.files[idx] = data.file;
    if (data.breakdown) state.breakdown = data.breakdown;
    if (renameFileModal) renameFileModal.close();
    renderCardHeader();
    renderFiles();
    showBanner(`Updated "${data.file.name}" (${data.file.folder}).`);
  });

  // Claim Shared Code Modal
  const claimShareModal = document.getElementById('claimShareModal');
  on('btnOpenClaimShareModal', 'click', () => claimShareModal && claimShareModal.showModal());
  on('btnCloseClaimShareModal', 'click', () => claimShareModal && claimShareModal.close());

  on('claimShareForm', 'submit', async (e) => {
    e.preventDefault();
    const shareCode = document.getElementById('claimShareCodeInput').value;
    const res = await fetch('/api/files/claim-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareCode })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Invalid share code', true);
      return;
    }
    state.user = data.user;
    state.files.unshift(data.file);
    if (data.breakdown) state.breakdown = data.breakdown;
    if (claimShareModal) claimShareModal.close();
    renderCardHeader();
    renderFiles();
    showBanner(
      `Mounted "${data.file.name}" (${formatBytes(
        data.file.sizeBytes
      )}) onto your Memory Card using 0 MB internet data!`
    );
  });

  // Cloud Direct URL Fetch Modal (0 MB Phone Data!)
  const remoteFetchModal = document.getElementById('remoteFetchModal');
  on('btnOpenRemoteFetchModal', 'click', () => remoteFetchModal && remoteFetchModal.showModal());
  on('btnCloseRemoteFetchModal', 'click', () => remoteFetchModal && remoteFetchModal.close());
  on('remoteFetchForm', 'submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('btnSubmitRemoteFetch');
    const url = document.getElementById('remoteFetchUrlInput').value;
    const name = document.getElementById('remoteFetchNameInput').value;
    const folder = document.getElementById('remoteFetchFolderSelect').value;

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Cloud Server Fetching at 1,000 Mbps...';
    }

    try {
      const res = await fetch('/api/files/remote-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name, folder })
      });
      const data = await res.json();
      if (!res.ok) {
        showBanner(data.error || 'Cloud fetch failed', true);
        return;
      }
      state.user = data.user;
      state.files.unshift(data.file);
      if (data.breakdown) state.breakdown = data.breakdown;
      if (remoteFetchModal) remoteFetchModal.close();
      e.target.reset();
      renderCardHeader();
      renderFiles();
      showBanner(data.message);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Fetch Directly to My Card (0 MB Phone Data)';
      }
    }
  });

  // Search
  on('fileSearchInput', 'input', (e) => {
    state.searchQuery = e.target.value;
    if (state.activeView !== 'view-files') {
      switchView('view-files');
    } else {
      renderFiles();
    }
  });

  // File Card Actions (Stream/Studio, Share, Rename, Vault, Trash, Restore, Delete Forever)
  on('filesGrid', 'click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const fileId = btn.dataset.id;

    if (action === 'stream') {
      openStreamModal(fileId);
    } else if (action === 'share') {
      const res = await fetch(`/api/files/${fileId}/share`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showBanner(data.error || 'Cannot share this file', true);
        return;
      }
      if (data.share) {
        navigator.clipboard.writeText(data.share.shareCode).catch(() => {});
        showBanner(
          `Zero-Data Share Code "${data.share.shareCode}" copied! Anyone can claim "${data.share.name}" using 0 MB data.`
        );
      }
    } else if (action === 'rename') {
      const file = state.files.find((f) => f.id === fileId);
      if (!file || !renameFileModal) return;
      document.getElementById('renameFileIdInput').value = file.id;
      document.getElementById('renameFileNameInput').value = file.name;
      document.getElementById('renameFileFolderSelect').value =
        file.folder === 'All Files' ? 'Documents' : file.folder;
      renameFileModal.showModal();
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
        if (data.breakdown) state.breakdown = data.breakdown;
        renderCardHeader();
        renderFiles();
        showBanner(
          data.file.isVaultLocked
            ? `Moved "${data.file.name}" to Private Vault.`
            : `Removed "${data.file.name}" from Private Vault.`
        );
      }
    } else if (action === 'trash') {
      const res = await fetch(`/api/files/${fileId}/trash`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const idx = state.files.findIndex((f) => f.id === fileId);
        if (idx >= 0) state.files[idx] = data.file;
        if (data.breakdown) state.breakdown = data.breakdown;
        renderCardHeader();
        renderFiles();
        showBanner(`Moved "${data.file.name}" to Trash. You can restore it anytime from Trash.`);
      }
    } else if (action === 'restore') {
      const res = await fetch(`/api/files/${fileId}/restore`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const idx = state.files.findIndex((f) => f.id === fileId);
        if (idx >= 0) state.files[idx] = data.file;
        if (data.breakdown) state.breakdown = data.breakdown;
        renderCardHeader();
        renderFiles();
        showBanner(`Restored "${data.file.name}" from Trash.`);
      }
    } else if (action === 'delete-forever' || action === 'delete') {
      const res = await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        state.files = state.files.filter((f) => f.id !== fileId);
        state.user = data.user;
        if (data.breakdown) state.breakdown = data.breakdown;
        renderCardHeader();
        renderFiles();
        showBanner('File permanently removed from Memory Card.');
      }
    }
  });

  // Cloud Studio Run & Save Buttons
  on('btnRunCloudCode', 'click', async () => {
    const textarea = document.getElementById('cloudStudioTextarea');
    const outBox = document.getElementById('cloudStudioOutputBox');
    if (!textarea || !outBox) return;

    const file = state.files.find((f) => f.id === state.activeStudioFileId);
    outBox.classList.remove('hidden');
    outBox.textContent = 'Running on Cloud Card Sandbox...';

    const res = await fetch('/api/workspace/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: textarea.value,
        filename: file ? file.name : 'script.js'
      })
    });
    const data = await res.json();
    outBox.textContent = `[Executed in ${data.durationMs}ms · 0B Local Disk]\n${data.output}`;
  });

  on('btnSaveCloudCode', 'click', async () => {
    const textarea = document.getElementById('cloudStudioTextarea');
    if (!textarea || !state.activeStudioFileId) return;

    const res = await fetch(`/api/files/${state.activeStudioFileId}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: textarea.value })
    });
    const data = await res.json();
    if (res.ok) {
      state.user = data.user;
      const idx = state.files.findIndex((f) => f.id === state.activeStudioFileId);
      if (idx >= 0) state.files[idx] = data.file;
      renderCardHeader();
      renderFiles();
      showBanner(`Saved changes to "${data.file.name}" directly on your Memory Card.`);
    } else {
      showBanner(data.error || 'Could not save file', true);
    }
  });

  // Stream Modal Close
  const streamModal = document.getElementById('streamModal');
  on('btnCloseStreamModal', 'click', () => {
    const body = document.getElementById('streamModalBody');
    if (body) body.innerHTML = '';
    if (streamModal) streamModal.close();
  });

  // Mac Storage Doctor Actions
  on('btnRunDoctorScan', 'click', () => runMacStorageDoctorScan());
  on('doctorHotspotsGrid', 'click', (e) => {
    const btn = e.target.closest('button[data-copy-cmd]');
    if (!btn) return;
    navigator.clipboard.writeText(btn.dataset.copyCmd);
    showBanner(`Copied terminal cleanup command: ${btn.dataset.copyCmd}`);
  });

  // WebDAV Copy
  on('btnCopyWebdav', 'click', () => {
    navigator.clipboard.writeText(state.webdavUrl);
    showBanner('Personal WebDAV Drive Link copied to clipboard.');
  });

  // Upgrade Plan Selection
  const paymentModal = document.getElementById('paymentModal');
  on('plansGrid', 'click', (e) => {
    const btn = e.target.closest('button[data-upgrade-plan]');
    if (!btn || !paymentModal) return;
    const plan = state.plans[btn.dataset.upgradePlan];
    if (!plan) return;

    document.getElementById('paySelectedPlanId').value = plan.id;
    document.getElementById('payModalTitle').textContent = `Upgrade to ${plan.name}`;
    document.getElementById('payModalAmount').textContent = `₦${plan.priceNaira}`;
    document.getElementById('payModalPlanBadge').textContent = `${plan.name} (${plan.quotaLabel})`;
    paymentModal.showModal();
  });

  on('btnClosePayModal', 'click', () => paymentModal && paymentModal.close());

  on('btnCopyOpay', 'click', () => {
    navigator.clipboard.writeText(document.getElementById('opayNumberText').textContent);
    showBanner('OPay account number copied.');
  });

  on('btnCopyPalmpay', 'click', () => {
    navigator.clipboard.writeText(document.getElementById('palmpayNumberText').textContent);
    showBanner('PalmPay account number copied.');
  });

  on('paymentClaimForm', 'submit', async (e) => {
    e.preventDefault();
    const planId = document.getElementById('paySelectedPlanId').value;
    const channel = document.getElementById('payChannelSelect').value;
    const senderName = document.getElementById('paySenderNameInput').value;
    const sessionEl = document.getElementById('paySessionLast6Input');
    const sessionIdLast6 = sessionEl ? sessionEl.value : '';

    const res = await fetch('/api/payments/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, channel, senderName, sessionIdLast6 })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Could not submit payment claim', true);
      return;
    }

    if (paymentModal) paymentModal.close();
    state.payments.unshift(data.payment);
    await fetchPendingClaims();
    renderPlansAndPayments();
    showBanner(
      `Transfer claim ${data.payment.reference} submitted! Click "Approve" in the Telegram Simulator below to test instant unlock.`
    );
  });

  on('adminPendingClaimsList', 'click', async (e) => {
    const btn = e.target.closest('button[data-resolve-id]');
    if (!btn) return;
    await fetch(`/api/payments/${btn.dataset.resolveId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: btn.dataset.resolveAction })
    });
  });

  // View Official Receipt Modal
  const receiptModal = document.getElementById('receiptModal');
  on('userPaymentsHistory', 'click', (e) => {
    const btn = e.target.closest('button[data-view-receipt]');
    if (!btn) return;
    const payment = state.payments.find((p) => p.id === btn.dataset.viewReceipt);
    if (payment) openReceiptModal(payment);
  });
  on('btnCloseReceiptModal', 'click', () => receiptModal && receiptModal.close());
  on('btnPrintReceipt', 'click', () => window.print());

  // Lock Card Modal
  const lockModal = document.getElementById('lockCardModal');
  on('btnOpenLockModal', 'click', () => lockModal && lockModal.showModal());
  on('btnCloseLockModal', 'click', () => lockModal && lockModal.close());

  on('lockCardForm', 'submit', async (e) => {
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
    if (data.auditLogs) state.auditLogs = data.auditLogs;
    if (lockModal) lockModal.close();
    renderCardHeader();
    renderSecurityAudit();
    if (data.recoveryKey) {
      navigator.clipboard.writeText(data.recoveryKey).catch(() => {});
      showBanner(
        `${data.message} · Emergency Recovery Key (${data.recoveryKey}) copied to clipboard!`
      );
    } else {
      showBanner(data.message);
    }
  });

  // Restore Card Modal & PIN Recovery Key Reset
  const restoreModal = document.getElementById('restoreCardModal');
  on('btnOpenRestoreModal', 'click', () => restoreModal && restoreModal.showModal());
  on('btnCloseRestoreModal', 'click', () => restoreModal && restoreModal.close());

  on('restoreCardForm', 'submit', async (e) => {
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
    if (restoreModal) restoreModal.close();
    await loadSession();
    showBanner(data.message);
  });

  const resetPinForm = document.getElementById('resetPinForm');
  on('btnTogglePinReset', 'click', () => {
    if (resetPinForm) resetPinForm.classList.toggle('hidden');
  });

  on(resetPinForm, 'submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('resetPhoneInput').value;
    const recoveryKey = document.getElementById('resetRecoveryKeyInput').value;
    const newPin = document.getElementById('resetNewPinInput').value;

    const res = await fetch('/api/auth/reset-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, recoveryKey, newPin })
    });
    const data = await res.json();
    if (!res.ok) {
      showBanner(data.error || 'Invalid Recovery Key', true);
      return;
    }
    if (data.recoveryKey) {
      navigator.clipboard.writeText(data.recoveryKey).catch(() => {});
    }
    resetPinForm.reset();
    resetPinForm.classList.add('hidden');
    if (restoreModal) restoreModal.close();
    await loadSession();
    showBanner(
      data.recoveryKey
        ? `PIN reset! New Emergency Recovery Key (${data.recoveryKey}) copied to clipboard.`
        : data.message
    );
  });

  // Local Wi-Fi P2P
  on('btnConnectP2P', 'click', connectP2PRoom);
  const p2pFileInput = document.getElementById('p2pFileInput');
  on('btnBeamP2PFile', 'click', () => p2pFileInput && p2pFileInput.click());
  on(p2pFileInput, 'change', (e) => {
    if (e.target.files[0]) beamLocalP2PFile(e.target.files[0]);
    p2pFileInput.value = '';
  });

  // 2. Now load session data and connect live SSE stream
  await loadSession();
  connectLiveEvents();

  // 3. Auto-open Claim Shared Code modal if opened via a /s/CARD-XXXX viral link (?claim=CARD-XXXX)
  const urlParams = new URLSearchParams(window.location.search);
  const incomingClaimCode = urlParams.get('claim');
  if (incomingClaimCode && claimShareModal) {
    const codeInput = document.getElementById('claimShareCodeInput');
    if (codeInput) codeInput.value = incomingClaimCode.toUpperCase();
    claimShareModal.showModal();
    window.history.replaceState({}, document.title, '/');
  }
});
