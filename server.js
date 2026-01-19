const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const { buildPalette } = require('./lib/palette');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const dbPath = process.env.DB_PATH || 'solara.db';
const NAS_DOWNLOAD_DIR = process.env.NAS_DOWNLOAD_DIR || path.join(__dirname, 'downloads');

// 确保下载目录存在
if (!fs.existsSync(NAS_DOWNLOAD_DIR)) {
  fs.mkdirSync(NAS_DOWNLOAD_DIR, { recursive: true });
}

// 初始化数据库
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS playback_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS favorites_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// 存储接口 (SQLite 替代原 Cloudflare D1)
app.get('/api/storage', (req, res) => {
  const { status, keys: keysParam } = req.query;

  if (status) {
    return res.json({ remoteAvailable: true });
  }

  const keys = (keysParam || '').split(',').map(k => k.trim()).filter(Boolean);
  const data = {};

  const favoriteKeys = new Set(["favoriteSongs", "currentFavoriteIndex", "favoritePlayMode", "favoritePlaybackTime"]);
  
  try {
    if (keys.length > 0) {
      keys.forEach(key => {
        const table = favoriteKeys.has(key) ? 'favorites_store' : 'playback_store';
        const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key);
        data[key] = row ? row.value : null;
      });
    }
    res.json({ remoteAvailable: true, data });
  } catch (error) {
    console.error('Storage get error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/storage', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data' });

  const favoriteKeys = new Set(["favoriteSongs", "currentFavoriteIndex", "favoritePlayMode", "favoritePlaybackTime"]);

  try {
    const upsertPlayback = db.prepare(`INSERT OR REPLACE INTO playback_store (key, value) VALUES (?, ?)`);
    const upsertFavorites = db.prepare(`INSERT OR REPLACE INTO favorites_store (key, value) VALUES (?, ?)`);

    const transaction = db.transaction((items) => {
      for (const [key, value] of Object.entries(items)) {
        if (favoriteKeys.has(key)) {
          upsertFavorites.run(key, typeof value === 'string' ? value : JSON.stringify(value));
        } else {
          upsertPlayback.run(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
    });

    transaction(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Storage post error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.delete('/api/storage', (req, res) => {
  const { keys: queryKeys } = req.query;
  const { keys: bodyKeys } = req.body;
  
  let keys = [];
  if (queryKeys) {
    keys = queryKeys.split(',').map(k => k.trim()).filter(Boolean);
  } else if (Array.isArray(bodyKeys)) {
    keys = bodyKeys;
  }

  if (keys.length === 0) return res.json({ success: true });

  const favoriteKeys = new Set(["favoriteSongs", "currentFavoriteIndex", "favoritePlayMode", "favoritePlaybackTime"]);

  try {
    const deletePlayback = db.prepare(`DELETE FROM playback_store WHERE key = ?`);
    const deleteFavorites = db.prepare(`DELETE FROM favorites_store WHERE key = ?`);

    const transaction = db.transaction((targetKeys) => {
      for (const key of targetKeys) {
        if (favoriteKeys.has(key)) {
          deleteFavorites.run(key);
        } else {
          deletePlayback.run(key);
        }
      }
    });

    transaction(keys);
    res.json({ success: true });
  } catch (error) {
    console.error('Storage delete error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Proxy 接口
const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.target;
  
  // 处理音频代理 (酷我)
  if (targetUrl && targetUrl.includes('kuwo.cn')) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
          'Referer': 'https://www.kuwo.cn/'
        }
      });
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', response.headers.get('content-type'));
      return response.body.pipe(res);
    } catch (error) {
      return res.status(500).send('Proxy error');
    }
  }

  // 处理 API 代理
  const url = new URL(API_BASE_URL);
  Object.keys(req.query).forEach(key => {
    if (key !== 'target') {
      url.searchParams.set(key, req.query[key]);
    }
  });

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0'
      }
    });
    const data = await response.text();
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/json');
    res.send(data);
  } catch (error) {
    res.status(500).send('API Proxy error');
  }
});

// 调色板接口 (Palette)
app.get('/palette', async (req, res) => {
    const imageUrl = req.query.image || req.query.url;
    if (!imageUrl) return res.status(400).send('Missing image URL');
    
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
            return res.status(415).json({ error: 'Unsupported content type' });
        }

        const buffer = await response.arrayBuffer();
        const palette = await buildPalette(Buffer.from(buffer), contentType);
        palette.source = imageUrl;

        res.set('Cache-Control', 'public, max-age=3600');
        res.json(palette);
    } catch (error) {
        console.error('Palette generation failed:', error);
        res.status(500).json({ error: 'Failed to analyze image' });
    }
});

// NAS 下载接口
app.post('/api/nas-download', async (req, res) => {
    const { url, filename } = req.body;
    if (!url || !filename) return res.status(400).json({ error: 'Missing url or filename' });

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

        const filePath = path.join(NAS_DOWNLOAD_DIR, filename);
        const fileStream = fs.createWriteStream(filePath);
        
        response.body.pipe(fileStream);

        fileStream.on('finish', () => {
            console.log(`File saved to NAS: ${filePath}`);
            res.json({ success: true, path: filePath });
        });

        fileStream.on('error', (err) => {
            console.error('File stream error:', err);
            res.status(500).json({ error: 'Failed to save file to NAS' });
        });
    } catch (error) {
        console.error('NAS download failed:', error);
        res.status(500).json({ error: 'Failed to download file to NAS' });
    }
});

app.listen(port, () => {
  console.log(`Solara server running at http://localhost:${port}`);
  console.log(`Using SQLite database at: ${path.resolve(dbPath)}`);
});
