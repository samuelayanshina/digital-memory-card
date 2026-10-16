import path from 'node:path';
import { db } from '../db/database.mjs';
import { storeStreamAsBlob, deletePhysicalBlob } from './storageEngine.mjs';
import { streamFileBlob } from './streamEngine.mjs';
import { pushToUser } from './realtimeAndBot.mjs';

function escapeXml(unsafe = '') {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.ts': 'text/plain',
    '.py': 'text/x-python',
    '.md': 'text/markdown',
    '.txt': 'text/plain'
  };
  return map[ext] || 'application/octet-stream';
}

function resolveWebDavUser(req, urlPath) {
  // 1. Check token in URL path: /webdav/<token>/...
  const segments = urlPath.replace(/^\/webdav\/?/, '').split('/').filter(Boolean);
  if (segments.length > 0) {
    const potentialUser = db.getUserByToken(segments[0]);
    if (potentialUser) {
      return {
        user: potentialUser,
        baseHref: `/webdav/${segments[0]}`,
        relativeSegments: segments.slice(1).map((s) => decodeURIComponent(s))
      };
    }
  }

  // 2. Check Basic Auth (Phone + 4-digit PIN, or Serial + Token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');
    const byToken = db.getUserByToken(password) || db.getUserByToken(username);
    if (byToken) {
      return {
        user: byToken,
        baseHref: '/webdav',
        relativeSegments: segments.map((s) => decodeURIComponent(s))
      };
    }
    const byPhone = db.authenticatePhoneAndPin(username, password);
    if (byPhone) {
      return {
        user: byPhone,
        baseHref: '/webdav',
        relativeSegments: segments.map((s) => decodeURIComponent(s))
      };
    }
  }

  return null;
}

export async function handleWebDavRequest(req, res) {
  res.setHeader('DAV', '1, 2');
  res.setHeader('MS-Author-Via', 'DAV');
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, LOCK, UNLOCK');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const resolved = resolveWebDavUser(req, urlObj.pathname);

  if (!resolved || !resolved.user) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="CardNG Digital Memory Card"',
      'Content-Type': 'text/plain'
    });
    res.end('Authentication required. Use your CardNG WebDAV URL or Phone + 4-digit PIN.');
    return;
  }

  const { user, baseHref, relativeSegments } = resolved;
  const userFiles = db.getUserFiles(user.id).filter((f) => !f.isVaultLocked && !f.isTrashed);

  // macOS Finder Lock/Unlock support
  if (req.method === 'LOCK') {
    const lockToken = `opaquelocktoken:${user.id}-${Date.now()}`;
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>infinity</D:depth>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>${lockToken}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${lockToken}>`
    });
    res.end(xml);
    return;
  }

  if (req.method === 'UNLOCK' || req.method === 'MKCOL') {
    res.writeHead(204);
    res.end();
    return;
  }

  // PROPFIND: List files in Finder / Windows Explorer
  if (req.method === 'PROPFIND') {
    const depth = req.headers.depth ?? '1';
    const targetName = relativeSegments[relativeSegments.length - 1] || null;

    if (targetName) {
      const matchedFile = userFiles.find((f) => f.name === targetName);
      if (!matchedFile) {
        res.writeHead(404);
        res.end();
        return;
      }
      const fileXml = buildPropfindXml([
        buildFileDavNode(`${baseHref}/${encodeURIComponent(matchedFile.name)}`, matchedFile)
      ]);
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(fileXml);
      return;
    }

    const nodes = [
      buildCollectionDavNode(`${baseHref}/`, `CardNG (${user.cardSerial})`, user.createdAt)
    ];

    if (depth !== '0') {
      for (const file of userFiles) {
        nodes.push(buildFileDavNode(`${baseHref}/${encodeURIComponent(file.name)}`, file));
      }
    }

    const xml = buildPropfindXml(nodes);
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
    return;
  }

  const targetFilename = relativeSegments[relativeSegments.length - 1];
  if (!targetFilename) {
    res.writeHead(400);
    res.end('Filename required');
    return;
  }

  // Ignore macOS Finder metadata clutter (.DS_Store, ._*) from consuming real storage
  if (targetFilename === '.DS_Store' || targetFilename.startsWith('._')) {
    if (req.method === 'PUT' || req.method === 'DELETE') {
      req.resume();
      res.writeHead(201);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = userFiles.find((f) => f.name === targetFilename);
    if (!file) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    streamFileBlob(req, res, file, { download: false });
    return;
  }

  if (req.method === 'PUT') {
    try {
      const remainingQuota = Math.max(0, user.quotaBytes - user.usedBytes);
      const { sha256, sizeBytes } = await storeStreamAsBlob(req, {
        maxBytes: remainingQuota
      });
      const mimeType = guessMimeType(targetFilename);
      const { deduplicated } = db.registerOrIncrementBlob({ sha256, sizeBytes, mimeType });

      // Remove existing file with same name if overwriting
      const existingSameName = userFiles.find((f) => f.name === targetFilename);
      if (existingSameName) {
        const delResult = db.deleteFileRecord(existingSameName.id, user.id);
        if (delResult?.shouldDeletePhysicalBlob) {
          deletePhysicalBlob(existingSameName.sha256);
        }
      }

      const created = db.createFileRecord({
        userId: user.id,
        name: targetFilename,
        folder: 'Mac/PC Drive',
        sha256,
        sizeBytes,
        mimeType,
        deduplicated
      });

      pushToUser(user.id, { type: 'FILES_UPDATED', file: created });
      res.writeHead(201);
      res.end();
    } catch (err) {
      res.writeHead(507, { 'Content-Type': 'text/plain' });
      res.end(err.message);
    }
    return;
  }

  if (req.method === 'DELETE') {
    const file = userFiles.find((f) => f.name === targetFilename);
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    const result = db.deleteFileRecord(file.id, user.id);
    if (result?.shouldDeletePhysicalBlob) {
      deletePhysicalBlob(file.sha256);
    }
    pushToUser(user.id, { type: 'FILES_UPDATED', deletedId: file.id });
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
}

function buildCollectionDavNode(href, displayName, createdAt) {
  const modified = new Date(createdAt || Date.now()).toUTCString();
  return `
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(displayName)}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>${modified}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function buildFileDavNode(href, file) {
  const modified = new Date(file.createdAt || Date.now()).toUTCString();
  return `
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(file.name)}</D:displayname>
        <D:resourcetype/>
        <D:getcontentlength>${file.sizeBytes}</D:getcontentlength>
        <D:getcontenttype>${escapeXml(file.mimeType)}</D:getcontenttype>
        <D:getlastmodified>${modified}</D:getlastmodified>
        <D:getetag>"${file.sha256.slice(0, 16)}"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function buildPropfindXml(responseNodes) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
${responseNodes.join('\n')}
</D:multistatus>`;
}
