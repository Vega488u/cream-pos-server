const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

const DATA_DIR = path.join(__dirname, 'data');
const BACKUPS_ROOT = path.join(__dirname, 'backups');
const AUTO_STATE_BACKUPS = path.join(BACKUPS_ROOT, 'state_snapshots');
const STATE_FILE = path.join(DATA_DIR, 'central_state.json');
const TEMP_FILE = path.join(DATA_DIR, 'central_state.tmp');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
fs.mkdirSync(AUTO_STATE_BACKUPS, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

function createEmptyState() {
  return {
    updatedAt: null,
    sales: [],
    pendingDeliveries: [],
    products: null,
    branches: null,
    users: null,
    categories: null,
    customers: null,
    promotions: null,
    callCenterOrders: [],
    factoryOrders: []
  };
}

function isValidJsonString(str) {
  if (typeof str !== 'string' || str.trim().length < 2) return false;
  const parsed = JSON.parse(str);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
}

function getLatestBackupFile(dir = BACKUPS_ROOT) {
  let latestFile = null;
  let latestMtime = 0;

  function scanDir(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latestMtime && stat.size > 2) {
          latestMtime = stat.mtimeMs;
          latestFile = fullPath;
        }
      }
    }
  }

  scanDir(dir);
  return latestFile;
}

function backupCurrentStateFile(reason = 'auto') {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!isValidJsonString(raw)) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = String(reason).replace(/[^a-zA-Z0-9_-]/g, '_');
    const snapPath = path.join(AUTO_STATE_BACKUPS, `state_${safeReason}_${stamp}.json`);
    fs.writeFileSync(snapPath, raw, 'utf8');

    // الاحتفاظ بآخر 50 لقطة تلقائية فقط لتجنب تضخم القرص
    const files = fs.readdirSync(AUTO_STATE_BACKUPS)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        fullPath: path.join(AUTO_STATE_BACKUPS, f),
        mtime: fs.statSync(path.join(AUTO_STATE_BACKUPS, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const oldFile of files.slice(50)) {
      fs.unlinkSync(oldFile.fullPath);
    }

    return snapPath;
  } catch (e) {
    console.error('⚠️ Failed to snapshot central_state.json:', e.message);
    return null;
  }
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!isValidJsonString(raw)) {
      throw new Error('central_state.json is empty or not an object');
    }
    const parsed = JSON.parse(raw);
    return {
      ...createEmptyState(),
      ...parsed
    };
  } catch (e) {
    console.error('⚠️ Corrupt or unreadable central_state.json:', e.message);
    // حفظ نسخة من الملف التالف للفحص دون مسحه
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(STATE_FILE, path.join(BACKUPS_ROOT, `corrupt_state_${stamp}.json`));
    } catch (_) {}

    // محاولة الاسترجاع من أحدث نسخة احتياطية سليمة إن وجدت
    const fallbackFile = getLatestBackupFile(AUTO_STATE_BACKUPS) || getLatestBackupFile(BACKUPS_ROOT);
    if (fallbackFile) {
      try {
        const fallbackRaw = fs.readFileSync(fallbackFile, 'utf8');
        if (isValidJsonString(fallbackRaw)) {
          console.log('✅ Recovered state from backup:', fallbackFile);
          return {
            ...createEmptyState(),
            ...JSON.parse(fallbackRaw)
          };
        }
      } catch (_) {}
    }

    return createEmptyState();
  }
}

function writeState(nextState) {
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    throw new Error('Refused to write invalid state object');
  }

  backupCurrentStateFile('before_write');

  const safeCopy = {
    ...nextState,
    updatedAt: new Date().toISOString()
  };

  const serialized = JSON.stringify(safeCopy, null, 2);
  JSON.parse(serialized); // تحقق نهائي من سلامة JSON قبل الكتابة

  fs.writeFileSync(TEMP_FILE, serialized, 'utf8');
  fs.renameSync(TEMP_FILE, STATE_FILE);
  return safeCopy;
}

function mergeByKey(existingArr, incomingArr, keyField) {
  const map = new Map();
  (Array.isArray(existingArr) ? existingArr : []).forEach(item => {
    if (item && item[keyField] !== undefined) map.set(item[keyField], item);
  });
  (Array.isArray(incomingArr) ? incomingArr : []).forEach(item => {
    if (item && item[keyField] !== undefined) map.set(item[keyField], item);
  });
  return Array.from(map.values());
}

app.get('/api/health', (req, res) => {
  const state = readState();
  res.json({
    ok: true,
    service: 'Cream POS Central Server',
    updatedAt: state.updatedAt,
    salesCount: (state.sales || []).length
  });
});

app.get('/api/state', (req, res) => {
  res.json({ ok: true, state: readState() });
});

app.get('/api/backup', (req, res) => {
  try {
    const latestFile = getLatestBackupFile(BACKUPS_ROOT);
    if (latestFile) {
      const raw = fs.readFileSync(latestFile, 'utf8');
      return res.type('application/json').send(raw);
    }

    const state = readState();
    if (state && (state.users || state.products || state.branches || (state.sales && state.sales.length > 0))) {
      return res.json(state);
    }

    return res.status(404).json({ ok: false, message: 'No backup found yet' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync', (req, res) => {
  try {
    const body = req.body || {};
    const state = readState();

    if (Array.isArray(body.sales) && body.sales.length > 0) {
      state.sales = mergeByKey(state.sales, body.sales, 'invNo');
    }
    if (Array.isArray(body.pendingDeliveries) && body.pendingDeliveries.length > 0) {
      state.pendingDeliveries = mergeByKey(state.pendingDeliveries, body.pendingDeliveries, 'invNo');
    }
    if (Array.isArray(body.callCenterOrders) && body.callCenterOrders.length > 0) {
      state.callCenterOrders = mergeByKey(state.callCenterOrders, body.callCenterOrders, 'invNo');
    }
    if (Array.isArray(body.factoryOrders) && body.factoryOrders.length > 0) {
      state.factoryOrders = mergeByKey(state.factoryOrders, body.factoryOrders, 'id');
    }
    if (Array.isArray(body.customers) && body.customers.length > 0) {
      state.customers = mergeByKey(state.customers, body.customers, 'id');
    }
    if (Array.isArray(body.products) && body.products.length > 0) state.products = body.products;
    if (Array.isArray(body.branches) && body.branches.length > 0) state.branches = body.branches;
    if (Array.isArray(body.users) && body.users.length > 0) state.users = body.users;
    if (Array.isArray(body.categories) && body.categories.length > 0) state.categories = body.categories;
    if (Array.isArray(body.promotions) && body.promotions.length > 0) state.promotions = body.promotions;

    const savedState = writeState(state);

    res.json({
      ok: true,
      message: 'تمت المزامنة بنجاح مع السيرفر الرئيسي',
      updatedAt: savedState.updatedAt,
      state: savedState
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup', (req, res) => {
  try {
    const folderName = (req.body && req.body.folder ? String(req.body.folder) : 'Cream_Auto_Backups')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const targetDir = path.join(BACKUPS_ROOT, folderName);
    fs.mkdirSync(targetDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(targetDir, `backup_${stamp}.json`);
    const payload = req.body && req.body.data !== undefined ? req.body.data : req.body;
    const serialized = JSON.stringify(payload, null, 2);
    JSON.parse(serialized);

    fs.writeFileSync(filePath, serialized, 'utf8');
    res.json({ ok: true, savedTo: filePath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  backupCurrentStateFile('startup');
  console.log(`==================================================`);
  console.log(`🍦 Cream POS Central Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`==================================================`);
});