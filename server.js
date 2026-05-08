require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const multer    = require('multer');
const QRCode    = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const fs        = require('fs');

// ─── Setup ────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PHOTOS_DIR = process.env.PHOTOS_DIR
  ? path.resolve(process.env.PHOTOS_DIR)
  : path.join(__dirname, 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTOS_DIR));
app.set('trust proxy', true); // indispensable pour req.protocol = 'https' sur Render

// ─── Store ────────────────────────────────────────────────────────────────────

const sessions = new Map();
const gallery  = [];

function getOrCreate(id) {
  if (!sessions.has(id)) sessions.set(id, { tabletWs: null, phoneWs: null, photos: [] });
  return sessions.get(id);
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let sessionId = null, role = null;

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
      // ✅ NOUVEAU : téléphone informe la tablette qu'un compte à rebours commence
      case 'photo-start': {
        const s = sessions.get(msg.sessionId);
        if (s) send(s.tabletWs, { type: 'photo-start', index: msg.index, total: msg.total });
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
    if (role === 'phone')  { s.phoneWs  = null; send(s.tabletWs, { type: 'phone-disconnected' }); }
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

app.post('/api/strip', async (req, res) => {
  try {
    const { imageData, sessionId } = req.body;
    if (!imageData) return res.status(400).json({ error: 'imageData manquant' });

    const base64   = imageData.replace(/^data:image\/\w+;base64,/, '');
    const filename = `strip_${uuidv4()}.jpg`;
    const filepath = path.join(PHOTOS_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

    // ✅ FIX URL : BASE_URL prioritaire, sinon reconstruction propre
    const rawBase = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const baseUrl = rawBase.replace(/\/$/, ''); // retirer slash final
    const stripUrl = `${baseUrl}/photos/${filename}`;
    console.log(`[strip] Sauvegardé : ${filename}`);
    console.log(`[strip] URL publique : ${stripUrl}`);

    const qrCode = await QRCode.toDataURL(stripUrl, {
      width: 320, margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });

    gallery.unshift({ url: stripUrl, filename, filepath, qrCode, createdAt: new Date().toISOString(), sessionId: sessionId || 'unknown' });
    if (gallery.length > 200) gallery.pop();

    res.json({ stripUrl, qrCode, filename });
  } catch (err) {
    console.error('[strip] Erreur :', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gallery', (req, res) => {
  res.json(gallery.map(({ url, qrCode, createdAt, sessionId }) => ({ url, qrCode, createdAt, sessionId })));
});

// ─── Email ────────────────────────────────────────────────────────────────────
// ✅ Utilise Resend (API HTTP) en priorité → fonctionne sur Render free
// Fallback : nodemailer SMTP (peut être bloqué sur Render free)
// Créez un compte gratuit sur https://resend.com → 3000 emails/mois

app.post('/api/email', async (req, res) => {
  const { email, stripUrl, filename } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Adresse email invalide' });

  // Pièce jointe
  let b64 = null;
  if (filename) {
    const fp = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(fp)) b64 = fs.readFileSync(fp).toString('base64');
  }

  const html = buildHtml(stripUrl);

  // ── Resend API ──
  if (process.env.RESEND_API_KEY) {
    try {
      const payload = {
        from:    process.env.EMAIL_FROM || 'Photobooth Bal 2026 <onboarding@resend.dev>',
        to:      [email],
        subject: '🎉 Votre strip du Bal de fin d\'année 2026 !',
        html,
        ...(b64 && { attachments: [{ filename: 'strip-bal-2026.jpg', content: b64 }] })
      };
      const r = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || JSON.stringify(data));
      console.log(`[email/resend] Envoyé à ${email}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[email/resend]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Fallback nodemailer SMTP ──
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      await t.sendMail({
        from:        `"📸 Photobooth Bal 2026" <${process.env.EMAIL_USER}>`,
        to:          email,
        subject:     '🎉 Votre strip du Bal de fin d\'année 2026 !',
        html,
        attachments: b64 ? [{ filename: 'strip-bal-2026.jpg', content: Buffer.from(b64, 'base64') }] : []
      });
      console.log(`[email/nodemailer] Envoyé à ${email}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[email/nodemailer]', err.message);
      return res.status(500).json({
        error: `Erreur SMTP: ${err.message}. Sur Render, utilisez RESEND_API_KEY (https://resend.com).`
      });
    }
  }

  return res.status(503).json({
    error: 'Email non configuré. Ajoutez RESEND_API_KEY dans vos variables d\'environnement Render.'
  });
});

function buildHtml(stripUrl) {
  return `<div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#0a0a1a;color:#e8e8f0;border-radius:16px;overflow:hidden;">
    <div style="background:#1a1a2e;padding:32px;text-align:center;">
      <h1 style="color:#d4af37;font-size:28px;margin:0;">✦ Bal de fin d'année 2026 ✦</h1>
    </div>
    <div style="padding:32px;">
      <p style="font-size:18px;">Merci pour ce super moment au photobooth ! 🥂</p>
      <p>Votre strip est en pièce jointe. Retrouvez-le aussi en ligne :</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${stripUrl}" style="background:#d4af37;color:#0a0a1a;font-weight:700;padding:14px 32px;text-decoration:none;border-radius:99px;display:inline-block;font-size:16px;">Voir mon strip →</a>
      </div>
      <p style="color:#7070a0;font-size:12px;text-align:center;">Bal de fin d'année 2026 — Photobooth</p>
    </div>
  </div>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎉 Photobooth Bal 2026 — Port ${PORT}`);
  console.log(`   Photos   : ${PHOTOS_DIR}`);
  console.log(`   BASE_URL : ${process.env.BASE_URL || '(auto-détecté depuis req)'}`);
  console.log(`   Tablette : http://localhost:${PORT}/tablet.html\n`);
});
