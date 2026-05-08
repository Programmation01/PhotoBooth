# 📸 Photobooth — Bal de fin d'année 2026

Système de photobooth complet : téléphone caméra + tablette interface + serveur distant.

## Architecture

```
📱 Téléphone  ←──WebSocket──→  🖥️ Serveur  ←──WebSocket──→  📟 Tablette
  (caméra)                      (Node.js)                  (interface)
```

## Structure des fichiers

```
photobooth/
├── server.js          — Serveur Express + WebSocket
├── package.json
├── .env               — Variables d'environnement (à créer depuis .env.example)
├── .env.example
├── photos/            — Dossier créé automatiquement au démarrage
└── public/
    ├── phone.html     — Interface téléphone (caméra)
    └── tablet.html    — Interface tablette (pilotage + galerie)
```

## Déploiement sur Render

1. **Créez un nouveau Web Service** sur [render.com](https://render.com)
2. Connectez votre dépôt GitHub (ou uploadez les fichiers)
3. Paramètres :
   - **Build command** : `npm install`
   - **Start command** : `npm start`
   - **Instance type** : Free (suffisant) ou Starter pour plus de stabilité
4. **Variables d'environnement** (onglet Environment) :
   - `BASE_URL` → URL de votre service (ex: `https://photobooth-bal.onrender.com`)
   - `EMAIL_USER` → votre email Gmail
   - `EMAIL_PASS` → mot de passe d'application Google (16 caractères)
5. **Persistent Disk** (recommandé) : montez un disque sur `/opt/render/project/src/photos`
   pour que les photos survivent aux redémarrages

> ⚠️ Sans disque persistant (plan gratuit), les photos sont perdues au redémarrage.
> Pour une soirée courte c'est acceptable, sinon optez pour un VPS ou le plan Starter.

## Déploiement local (test)

```bash
npm install
cp .env.example .env
# Éditez .env avec vos valeurs
npm start
# Ouvre http://localhost:3000/tablet.html sur la tablette
```

## Utilisation le soir du bal

1. Ouvrez `https://votre-serveur.onrender.com/tablet.html` sur la tablette
2. La tablette affiche un QR code
3. Scannez ce QR code avec le téléphone → la caméra démarre automatiquement
4. La tablette affiche le preview live
5. Appuyez sur **"Démarrer le strip"** → 4 photos avec compte à rebours automatique
6. Personnalisez avec stickers et texte
7. Validez → QR code de téléchargement affiché + envoi email optionnel

## Configuration email (Gmail)

1. Activez la validation en 2 étapes sur votre compte Google
2. Allez dans Compte Google → Sécurité → Mots de passe d'application
3. Créez un mot de passe pour "Autre application" → nommez-le "Photobooth"
4. Copiez les 16 caractères dans `EMAIL_PASS`

## Personnalisation future

Toutes les couleurs sont dans les variables CSS de `tablet.html` (`:root { --gold, --bg... }`).
Pour ajouter un thème, modifiez simplement ces variables.

## Technologies

- **Node.js** + Express + ws (WebSocket)
- **Vanilla JS** côté client (aucun framework)
- **nodemailer** pour les emails
- **qrcode** npm pour les QR codes serveur
- **qrcodejs** CDN pour les QR codes côté tablette
