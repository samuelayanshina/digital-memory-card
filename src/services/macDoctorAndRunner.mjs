import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

function estimateDirectoryBytesBounded(dirPath, maxEntries = 250) {
  let totalBytes = 0;
  let count = 0;

  function walk(current) {
    if (count >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxEntries) break;
      count += 1;
      const full = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile()) {
          const st = fs.statSync(full);
          totalBytes += st.size;
        } else if (entry.isDirectory()) {
          walk(full);
        }
      } catch {
        // Ignore permission restricted files
      }
    }
  }

  walk(dirPath);
  return { sampledBytes: totalBytes, sampledFilesCount: count };
}

export function scanDeveloperStorageHotspots() {
  const home = os.homedir();
  const candidates = [
    {
      id: 'xcode-derived',
      title: 'Xcode DerivedData (Build Caches)',
      path: path.join(home, 'Library/Developer/Xcode/DerivedData'),
      actionType: 'clean',
      recommendation: 'Safe to clear anytime — Xcode rebuilds active project index automatically.',
      command: 'rm -rf ~/Library/Developer/Xcode/DerivedData/*'
    },
    {
      id: 'npm-cache',
      title: 'NPM & Node Package Cache',
      path: path.join(home, '.npm'),
      actionType: 'clean',
      recommendation: 'Cached tarballs from old npm installs.',
      command: 'npm cache clean --force'
    },
    {
      id: 'gradle-cache',
      title: 'Android & Gradle Build Cache',
      path: path.join(home, '.gradle/caches'),
      actionType: 'clean',
      recommendation: 'Old Android/Java build artifacts.',
      command: 'rm -rf ~/.gradle/caches/*'
    },
    {
      id: 'downloads-folder',
      title: 'Downloads Folder (Installers, Videos & Zips)',
      path: path.join(home, 'Downloads'),
      actionType: 'offload',
      recommendation: 'Offload heavy .mp4, .zip, and datasets to your CardNG Memory Card, then delete locally.',
      command: 'open ~/Downloads'
    }
  ];

  const results = candidates.map((item) => {
    const exists = fs.existsSync(item.path);
    const { sampledBytes, sampledFilesCount } = exists
      ? estimateDirectoryBytesBounded(item.path, 300)
      : { sampledBytes: 0, sampledFilesCount: 0 };

    return {
      ...item,
      exists,
      sampledBytes,
      sampledFilesCount
    };
  });

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    hotspots: results
  };
}

export function executeCodeInCardSandbox(code = '', filename = 'script.js') {
  const logs = [];
  const startTime = performance.now();

  const customConsole = {
    log: (...args) => logs.push(args.map(formatVal).join(' ')),
    info: (...args) => logs.push(args.map(formatVal).join(' ')),
    warn: (...args) => logs.push('[WARN] ' + args.map(formatVal).join(' ')),
    error: (...args) => logs.push('[ERROR] ' + args.map(formatVal).join(' '))
  };

  function formatVal(v) {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  try {
    const sandbox = {
      console: customConsole,
      Math,
      Date,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      Buffer: {
        from: (str, enc) => Buffer.from(str, enc),
        byteLength: (str) => Buffer.byteLength(str)
      }
    };

    const context = vm.createContext(sandbox);
    const script = new vm.Script(String(code), { filename });
    const result = script.runInContext(context, { timeout: 1500 });
    const durationMs = (performance.now() - startTime).toFixed(2);

    if (result !== undefined) {
      logs.push(`→ Return: ${formatVal(result)}`);
    }

    return {
      ok: true,
      durationMs,
      output: logs.length > 0 ? logs.join('\n') : '(Executed with no console output)'
    };
  } catch (err) {
    const durationMs = (performance.now() - startTime).toFixed(2);
    return {
      ok: false,
      durationMs,
      output: [...logs, `✖ Runtime Error: ${err.message}`].join('\n')
    };
  }
}
