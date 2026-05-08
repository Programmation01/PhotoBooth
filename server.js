require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const QRCode     = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');

// ─── Setup ────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ✅ FIX : PHOTOS_DIR configurable via env (pour Render Persistent Disk)
// Sur Render : PHOTOS_DIR=/var/data/photos  +  Disk monté sur /var/data
const PHOTOS_DIR = process.env.PHOTOS_DIR
  ? path.resolve(process.env.PHOTOS_DIR)
  : path.join(__dirname, 'photos');

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTOS_DIR));

// Activer trust proxy pour récupérer le bon protocole derrière Render/Nginx
app.set('trust proxy', true);

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();
const gallery  = [];

function getOrCreate(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { tabletWs: null, phoneWs: null, photos: [] });
  }
  return sessions.get(id);
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let sessionId = null;
  let role      = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'register': {
        sessionId = msg.sessionId;
        role      = msg.role;
        const s   = getOrCreate(sessionId);
        s[role + 'Ws'] = ws;
        if (role === 'phone')  send(s.tabletWs, { type: 'phone-connected' });
        if (role === 'tablet' && s.phoneWs) send(ws, { type: 'phone-connected' });
        break;
      }
      case 'frame': {
        const s = sessions.get(msg.sessionId);
        if (s) send(s.tabletWs, { type: 'frame', data: msg.data });
        break;
      }
      case 'trigger': {
        const s = sessions.get(msg.sessionId);
        if (s) send(s.phoneWs, { type: 'trigger', count: msg.count || 4 });
        break;
      }
      case 'photo-captured': {
        const s = sessions.get(msg.sessionId);
        if (!s) break;
        s.photos.push(msg.url);
        send(s.tabletWs, { type: 'photo-captured', url: msg.url, index: msg.index, total: msg.total });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    if (role === 'phone')  { s.phoneWs = null;  send(s.tabletWs, { type: 'phone-disconnected' }); }
    if (role === 'tablet') { s.tabletWs = null; }
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/session', (req, res) => {
  const id = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  res.json({ sessionId: id });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTOS_DIR),
    filename:    (req, file, cb) => cb(null, `photo_${uuidv4()}.jpg`)
  })
});

app.post('/api/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  console.log(`[photo] Sauvegardé : ${req.file.filename}`);
  res.json({ url: `/photos/${req.file.filename}` });
});

// Upload strip final
app.post('/api/strip', async (req, res) => {
  try {
    const { imageData, sessionId } = req.body;
    if (!imageData) return res.status(400).json({ error: 'imageData manquant' });

    const base64   = imageData.replace(/^data:image\/\w+;base64,/, '');
    const filename = `strip_${uuidv4()}.jpg`;
    const filepath = path.join(PHOTOS_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    console.log(`[strip] Sauvegardé : ${filepath}`);

    // ✅ FIX : utilise x-forwarded-proto pour avoir https:// sur Render
    // trust proxy = true permet à req.protocol de retourner le bon proto
    const baseUrl  = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const stripUrl = `${baseUrl}/photos/${filename}`;
    console.log(`[strip] URL : ${stripUrl}`);

    const qrCode = await QRCode.toDataURL(stripUrl, {
      width:  300,
      margin: 2,
      color:  { dark: '#1a1a2e', light: '#ffffff' }
    });

    gallery.unshift({ url: stripUrl, filename, filepath, qrCode, createdAt: new Date().toISOString() });
    if (gallery.length > 100) gallery.pop();

    res.json({ stripUrl, qrCode, filename });
  } catch (err) {
    console.error('[strip] Erreur :', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gallery', (req, res) => {
  res.json(gallery.map(({ url, qrCode, createdAt }) => ({ url, qrCode, createdAt })));
});

app.post('/api/email', async (req, res) => {
  const { email, stripUrl, filename } = req.body;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)
    return res.status(503).json({ error: 'Email non configuré (voir .env)' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Adresse email invalide' });

  try {
    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    const filepath = path.join(PHOTOS_DIR, filename);
    const attachments = fs.existsSync(filepath)
      ? [{ filename: 'strip-bal-2026.jpg', path: filepath }]
      : [];

    await transporter.sendMail({
      from:    `"📸 Photobooth Bal 2026" <${process.env.EMAIL_USER}>`,
      to:      email,
      subject: '🎉 Votre strip du Bal de fin d\'année 2026 !',
      html: `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;
                    background:#0a0a1a;color:#e8e8f0;border-radius:16px;overflow:hidden;">
          <div style="background:#1a1a2e;padding:32px;text-align:center;">
            <h1 style="color:#d4af37;font-size:28px;margin:0;">✦ Bal de fin d'année 2026 ✦</h1>
          </div>
          <div style="padding:32px;">
            <p style="font-size:18px;">Merci pour ce super moment au photobooth ! 🥂</p>
            <p>Votre strip est en pièce jointe. Retrouvez-le aussi en ligne :</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${stripUrl}"
                 style="background:#d4af37;color:#0a0a1a;font-weight:700;padding:14px 32px;
                        text-decoration:none;border-radius:99px;display:inline-block;font-size:16px;">
                Voir mon strip →
              </a>
            </div>
          </div>
        </div>`,
      attachments
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[email] Erreur :', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎉 Photobooth Bal 2026 — Port ${PORT}`);
  console.log(`   Photos : ${PHOTOS_DIR}`);
  console.log(`   Tablette : http://localhost:${PORT}/tablet.html\n`);
});        } else if (role === 'tablet') {
          if (s.phoneWs) send(ws, { type: 'phone-connected' });
        }
        break;
      }

      // Téléphone → Serveur → Tablette (frame de preview)
      case 'frame': {
        const s = sessions.get(msg.sessionId);
        if (s) send(s.tabletWs, { type: 'frame', data: msg.data });
        break;
      }

      // Tablette → Serveur → Téléphone (déclenchement)
      case 'trigger': {
        const s = sessions.get(msg.sessionId);
        if (s) send(s.phoneWs, { type: 'trigger', count: msg.count || 4 });
        break;
      }

      // Téléphone → Serveur → Tablette (photo prise)
      case 'photo-captured': {
        const s = sessions.get(msg.sessionId);
        if (!s) break;
        s.photos.push(msg.url);
        send(s.tabletWs, {
          type:  'photo-captured',
          url:   msg.url,
          index: msg.index,
          total: msg.total
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    if (role === 'phone') {
      s.phoneWs = null;
      send(s.tabletWs, { type: 'phone-disconnected' });
    } else if (role === 'tablet') {
      s.tabletWs = null;
    }
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// Nouvelle session
app.get('/api/session', (req, res) => {
  const id = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  res.json({ sessionId: id });
});

// Upload d'une photo individuelle (depuis le téléphone)
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
  filename:    (req, file, cb) => cb(null, `photo_${uuidv4()}.jpg`)
});
const upload = multer({ storage: photoStorage });

app.post('/api/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  res.json({ url: `/photos/${req.file.filename}` });
});

// Upload du strip final (base64 depuis la tablette)
app.post('/api/strip', async (req, res) => {
  try {
    const { imageData, sessionId } = req.body;
    if (!imageData) return res.status(400).json({ error: 'imageData manquant' });

    const base64   = imageData.replace(/^data:image\/\w+;base64,/, '');
    const filename = `strip_${uuidv4()}.jpg`;
    const filepath = path.join(PHOTOS_DIR, filename);

    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

    const baseUrl  = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const stripUrl = `${baseUrl}/photos/${filename}`;

    // QR code pointant vers le strip
    const qrDataUrl = await QRCode.toDataURL(stripUrl, {
      width:  300,
      margin: 2,
      color:  { dark: '#1a1a2e', light: '#ffffff' }
    });

    const entry = {
      url:       stripUrl,
      filename,
      filepath,
      qrCode:    qrDataUrl,
      createdAt: new Date().toISOString(),
      sessionId: sessionId || 'unknown'
    };
    gallery.unshift(entry);
    if (gallery.length > 100) gallery.pop();

    res.json({ stripUrl, qrCode: qrDataUrl, filename });
  } catch (err) {
    console.error('Strip upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Galerie
app.get('/api/gallery', (req, res) => {
  res.json(gallery.map(({ url, qrCode, createdAt, sessionId }) => ({
    url, qrCode, createdAt, sessionId
  })));
});

// Envoi par email
app.post('/api/email', async (req, res) => {
  const { email, stripUrl, filename } = req.body;

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.status(503).json({ error: 'Email non configuré sur le serveur (voir .env)' });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const attachments = [];
    const filepath = path.join(PHOTOS_DIR, filename);
    if (filename && fs.existsSync(filepath)) {
      attachments.push({ filename: 'strip-bal-2026.jpg', path: filepath });
    }

    await transporter.sendMail({
      from:    `"📸 Photobooth Bal 2026" <${process.env.EMAIL_USER}>`,
      to:      email,
      subject: '🎉 Votre strip du Bal de fin d\'année 2026 !',
      html: `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#0a0a1a;color:#e8e8f0;border-radius:16px;overflow:hidden;">
          <div style="background:#1a1a2e;padding:32px;text-align:center;">
            <h1 style="color:#d4af37;font-size:28px;margin:0;">✦ Bal de fin d'année 2026 ✦</h1>
          </div>
          <div style="padding:32px;">
            <p style="font-size:18px;">Merci pour ce super moment au photobooth ! 🥂</p>
            <p>Votre strip est en pièce jointe. Vous pouvez aussi le retrouver en ligne :</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${stripUrl}"
                 style="background:#d4af37;color:#0a0a1a;font-weight:700;padding:14px 32px;
                        text-decoration:none;border-radius:99px;display:inline-block;font-size:16px;">
                Voir mon strip →
              </a>
            </div>
            <p style="color:#7070a0;font-size:12px;text-align:center;margin-top:40px;">
              Bal de fin d'année 2026 — Photobooth
            </p>
          </div>
        </div>
      `,
      attachments
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎉 Photobooth Bal 2026 — Serveur lancé`);
  console.log(`   → http://localhost:${PORT}/tablet.html`);
  console.log(`   → http://localhost:${PORT}/phone.html\n`);
});
