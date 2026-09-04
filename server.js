const express = require('express');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const QRCode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// ============================================================
// GÜVENLİK ÖNLEMLERİ (SECURITY & HARDENING)
// ============================================================

// 1. Sunucu Bilgisini Gizle (Anti-Fingerprinting)
app.disable('x-powered-by');

// 2. HTTP Güvenlik Başlıkları (Helmet CSP, XSS, Clickjacking, Anti-Sniffing)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://fonts.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://*.steamstatic.com", "https://*.steampowered.com"],
            connectSrc: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' }, // Anti-Clickjacking
    noSniff: true,                   // Anti-MIME Sniffing
    xssFilter: true                  // Anti-XSS Injection
}));

app.use(express.json({ limit: '10kb' })); // Anti-Payload Bomb (Maksimum 10KB JSON isteği)
app.use(express.static(path.join(__dirname, 'public')));

// 3. Rate Limiting (DDoS & Brute Force Saldırı Koruması)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 dakika
    max: 2000,                 // IP başına 15 dakikada 2000 istek (Canlı polling desteği)
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.includes('/status') || req.path.includes('/accounts'),
    message: { success: false, error: 'Çok fazla istek yapıldı, lütfen biraz bekleyin (DDoS Koruması).' }
});
app.use('/api/', globalLimiter);

// Sıkı Giriş Sınırlaması (Brute-Force / Şifre Deneme Koruması)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 dakika
    max: 30,                  // IP başına 15 dakikada maks 30 şifre denemesi
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Çok fazla hatalı giriş denemesi yapıldı. Güvenlik nedeniyle 15 dakika bekleyin.' }
});
app.use('/api/account/login', loginLimiter);
app.use('/api/account/steamguard', loginLimiter);

// 4. Input Sanitization & Anti-Injection Middleware (XSS, SQLi, Prototype Pollution Koruması)
function sanitizeInput(input) {
    if (typeof input === 'string') {
        // HTML/Script/SQL karakterlerini temizle ve zararlı kodları etkisizleştir
        return input
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/'/g, '&#39;')
            .replace(/"/g, '&quot;')
            .replace(/`/g, '&#96;')
            .replace(/;/g, '')
            .trim();
    }
    return input;
}

app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') {
        // Prototype Pollution Koruması (__proto__ veya constructor tahrifatını engelleme)
        if (Object.prototype.hasOwnProperty.call(req.body, '__proto__') || Object.prototype.hasOwnProperty.call(req.body, 'constructor')) {
            return res.status(400).json({ success: false, error: 'Geçersiz veri yapısı' });
        }
        for (const key in req.body) {
            if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                // Şifre ve Steam Guard kodları asla sanitization işleminden geçirilmez
                if (key !== 'password' && key !== 'code') {
                    req.body[key] = sanitizeInput(req.body[key]);
                }
            }
        }
    }
    next();
});

// ============================================================
// STEAM IDLE VERİ YAPILARI
// ============================================================
const POPULAR_GAMES = [
    { appId: 730, name: 'Counter-Strike 2' },
    { appId: 570, name: 'Dota 2' },
    { appId: 440, name: 'Team Fortress 2' },
    { appId: 578080, name: 'PUBG: BATTLEGROUNDS' },
    { appId: 1172470, name: 'Apex Legends' },
    { appId: 252490, name: 'Rust' },
    { appId: 271590, name: 'Grand Theft Auto V' },
    { appId: 359550, name: "Tom Clancy's Rainbow Six Siege" },
    { appId: 1599340, name: 'Lost Ark' },
    { appId: 236390, name: 'War Thunder' },
    { appId: 304930, name: 'Unturned' },
    { appId: 431960, name: 'Wallpaper Engine' },
    { appId: 1245620, name: 'ELDEN RING' },
    { appId: 892970, name: 'Valheim' },
    { appId: 1091500, name: 'Cyberpunk 2077' },
    { appId: 413150, name: 'Stardew Valley' },
    { appId: 105600, name: 'Terraria' },
    { appId: 346110, name: 'ARK: Survival Evolved' },
    { appId: 381210, name: 'Dead by Daylight' },
    { appId: 1174180, name: 'Red Dead Redemption 2' },
    { appId: 550, name: 'Left 4 Dead 2' },
    { appId: 4000, name: "Garry's Mod" },
    { appId: 218620, name: 'PAYDAY 2' },
    { appId: 230410, name: 'Warframe' },
    { appId: 440900, name: 'Conan Exiles' },
    { appId: 739630, name: 'Phasmophobia' },
];

const accounts = new Map();
const sessionAccounts = new Map();
const pendingQrSessions = new Map();

function getAccountKey(sessionId, username) {
    const cleanSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanUser = String(username).toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '');
    return `${cleanSession}:${cleanUser}`;
}

function getOrCreateAccount(sessionId, username) {
    const key = getAccountKey(sessionId, username);
    if (accounts.has(key)) {
        return accounts.get(key);
    }

    const acc = {
        key,
        sessionId,
        username: String(username).trim(),
        nickname: null,
        persona: null,
        steamID: null,
        loggedIn: false,
        steamGuardNeeded: false,
        steamGuardType: null,
        pendingSteamGuardCallback: null,
        error: null,
        personaState: SteamUser.EPersonaState.Online,
        games: [],
        ownedGames: [],
        startTime: null,
        totalIdleSeconds: 0,
        dailySeconds: 0,
        weeklySeconds: 0,
        monthlySeconds: 0,
        client: null
    };

    accounts.set(key, acc);

    if (!sessionAccounts.has(sessionId)) {
        sessionAccounts.set(sessionId, new Set());
    }
    sessionAccounts.get(sessionId).add(key);

    return acc;
}

// 5. Bellek Şişmesi & Çöp Temizleyici (Garbage Collection & DoS Protection)
setInterval(() => {
    // Saniye sayacı
    for (const acc of accounts.values()) {
        if (acc.loggedIn && acc.games && acc.games.length > 0) {
            acc.totalIdleSeconds = (acc.totalIdleSeconds || 0) + 1;
            acc.dailySeconds = (acc.dailySeconds || 0) + 1;
            acc.weeklySeconds = (acc.weeklySeconds || 0) + 1;
            acc.monthlySeconds = (acc.monthlySeconds || 0) + 1;
        }
    }

    // Zaman aşımına uğramış QR oturumlarını bellekten temizle
    const now = Date.now();
    for (const [qrId, state] of pendingQrSessions.entries()) {
        if (state.createdAt && (now - state.createdAt > 180000)) { // 3 dakika
            pendingQrSessions.delete(qrId);
        }
    }
}, 1000);

function createSteamClientForAccount(acc) {
    if (acc.client) {
        try { acc.client.logOff(); } catch (e) {}
    }

    const client = new SteamUser({
        promptSteamGuardCode: false,
        dataDirectory: null,
        enablePicsCache: true
    });

    acc.client = client;

    client.on('loggedOn', () => {
        console.log(`✅ [${acc.username}] Steam girişi başarılı! SteamID: ${client.steamID}`);
        acc.loggedIn = true;
        acc.steamGuardNeeded = false;
        acc.error = null;
        acc.steamID = client.steamID ? client.steamID.getSteamID64() : null;
        if (!acc.startTime) acc.startTime = Date.now();

        try {
            client.setPersona(acc.personaState || SteamUser.EPersonaState.Online);
        } catch (e) {}
    });

    client.on('accountInfo', (name) => {
        acc.persona = sanitizeInput(name);
    });

    client.on('steamGuard', (domain, callback) => {
        console.log(`🔐 [${acc.username}] Steam Guard kodu bekleniyor (${domain ? 'e-posta: ' + domain : 'mobil uygulama'})`);
        acc.steamGuardNeeded = true;
        acc.steamGuardType = domain ? 'email' : 'app';
        acc.pendingSteamGuardCallback = callback;
    });

    client.on('ownershipCached', () => {
        try {
            const ownedAppIds = client.getOwnedApps() || [];
            console.log(`📦 [${acc.username}] ${ownedAppIds.length} adet oyun/lisans tespit edildi.`);

            const ownedList = [];
            ownedAppIds.forEach(appId => {
                const idNum = Number(appId);
                const pop = POPULAR_GAMES.find(g => g.appId === idNum);
                let name = pop ? pop.name : null;

                if (!name && client.picsCache && client.picsCache.apps && client.picsCache.apps[idNum]) {
                    const appInfo = client.picsCache.apps[idNum].appinfo;
                    if (appInfo && appInfo.common && appInfo.common.name) {
                        name = sanitizeInput(appInfo.common.name);
                    }
                }

                ownedList.push({
                    appId: idNum,
                    name: name || `Oyun #${idNum}`
                });
            });

            acc.ownedGames = ownedList;
        } catch (e) {
            console.error(`[${acc.username}] Oyun lisansları işlenirken hata:`, e);
        }
    });

    client.on('error', (err) => {
        console.error(`❌ [${acc.username}] Steam hatası:`, err.message);
        acc.loggedIn = false;
        acc.games = [];
        acc.error = getSteamErrorMessage(err);
    });

    client.on('disconnected', (eresult, msg) => {
        console.log(`🔌 [${acc.username}] Steam bağlantısı kesildi:`, msg);
        acc.loggedIn = false;
        acc.games = [];
    });

    return client;
}

function getSteamErrorMessage(err) {
    const messages = {
        61: 'Geçersiz şifre',
        63: 'Hesap kilitlendi - çok fazla hatalı giriş denemesi yapıldı',
        65: 'Steam Guard kodu geçersiz',
        66: 'Steam Guard kodu gerekli',
        84: 'Rate limit - biraz bekleyin ve tekrar deneyin',
        5: 'Geçersiz şifre',
    };
    return messages[err.eresult] || err.message || 'Bilinmeyen hata';
}

function getLeaderboardForSession(sessionId) {
    const keys = sessionAccounts.get(sessionId) || new Set();
    const list = [];

    for (const key of keys) {
        const acc = accounts.get(key);
        if (!acc) continue;

        list.push({
            username: acc.username,
            nickname: acc.nickname,
            persona: acc.persona || acc.username,
            totalIdleSeconds: acc.totalIdleSeconds || 0,
            dailySeconds: acc.dailySeconds || 0,
            weeklySeconds: acc.weeklySeconds || 0,
            monthlySeconds: acc.monthlySeconds || 0,
            isIdling: acc.games.length > 0,
            activeGamesCount: acc.games.length
        });
    }

    list.sort((a, b) => b.totalIdleSeconds - a.totalIdleSeconds);
    return list;
}

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/session/accounts', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.query.sid;
    if (!sessionId) return res.json({ success: true, accounts: [], leaderboard: [] });

    const keys = sessionAccounts.get(sessionId) || new Set();
    const result = [];

    for (const key of keys) {
        const acc = accounts.get(key);
        if (!acc) continue;

        const uptime = acc.startTime ? Math.floor((Date.now() - acc.startTime) / 1000) : 0;
        result.push({
            username: acc.username,
            nickname: acc.nickname,
            persona: acc.persona || acc.username,
            steamID: acc.steamID,
            loggedIn: acc.loggedIn,
            steamGuardNeeded: acc.steamGuardNeeded,
            steamGuardType: acc.steamGuardType,
            personaState: acc.personaState,
            isIdling: acc.games.length > 0,
            activeGamesCount: acc.games.length,
            activeGames: acc.games,
            ownedGamesCount: acc.ownedGames.length,
            totalIdleSeconds: acc.totalIdleSeconds,
            dailySeconds: acc.dailySeconds,
            weeklySeconds: acc.weeklySeconds,
            monthlySeconds: acc.monthlySeconds,
            error: acc.error,
            uptime
        });
    }

    const leaderboard = getLeaderboardForSession(sessionId);
    res.json({ success: true, accounts: result, leaderboard });
});

app.get('/api/account/status', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.query.sid;
    const username = req.query.username;

    if (!sessionId || !username) {
        return res.json({ success: false, error: 'Oturum ID ve kullanıcı adı gerekli' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);
    if (!acc) {
        return res.json({ success: false, error: 'Hesap bulunamadı' });
    }

    const uptime = acc.startTime ? Math.floor((Date.now() - acc.startTime) / 1000) : 0;
    const effectiveOwnedGames = (acc.ownedGames && acc.ownedGames.length > 0) ? acc.ownedGames : POPULAR_GAMES;

    res.json({
        success: true,
        username: acc.username,
        nickname: acc.nickname,
        persona: acc.persona || acc.username,
        steamID: acc.steamID,
        loggedIn: acc.loggedIn,
        steamGuardNeeded: acc.steamGuardNeeded,
        steamGuardType: acc.steamGuardType,
        personaState: acc.personaState,
        error: acc.error,
        games: acc.games,
        ownedGames: effectiveOwnedGames,
        totalIdleSeconds: acc.totalIdleSeconds,
        dailySeconds: acc.dailySeconds,
        weeklySeconds: acc.weeklySeconds,
        monthlySeconds: acc.monthlySeconds,
        uptime
    });
});

app.post('/api/account/login', (req, res) => {
    const sessionId = req.headers['x-session-id'] || (req.body && req.body.sid);
    const { username, password } = req.body || {};

    if (!sessionId || !username || !password) {
        return res.json({ success: false, error: 'Kullanıcı adı ve şifre gerekli' });
    }

    const acc = getOrCreateAccount(sessionId, username);
    acc.error = null;
    acc.steamGuardNeeded = false;

    const client = createSteamClientForAccount(acc);

    let responded = false;
    const sendResponse = (payload) => {
        if (responded || res.headersSent) return;
        responded = true;
        clearTimeout(timeout);
        clearInterval(checkInterval);
        res.json(payload);
    };

    client.once('loggedOn', () => {
        sendResponse({ success: true, username: acc.username });
    });

    client.once('steamGuard', (domain) => {
        sendResponse({ success: false, steamGuard: true, type: domain ? 'email' : 'app', username: acc.username });
    });

    client.once('error', (err) => {
        sendResponse({ success: false, error: getSteamErrorMessage(err) });
    });

    client.logOn({
        accountName: username,
        password: password
    });

    const timeout = setTimeout(() => {
        if (acc.steamGuardNeeded) {
            sendResponse({ success: false, steamGuard: true, type: acc.steamGuardType, username: acc.username });
        } else if (acc.error) {
            sendResponse({ success: false, error: acc.error });
        } else if (acc.loggedIn) {
            sendResponse({ success: true, username: acc.username });
        } else {
            sendResponse({ success: false, error: 'Bağlantı zaman aşımına uğradı. Şifrenizi kontrol edip tekrar deneyin.' });
        }
    }, 8000);

    const checkInterval = setInterval(() => {
        if (acc.loggedIn || acc.error || acc.steamGuardNeeded) {
            if (acc.steamGuardNeeded) {
                sendResponse({ success: false, steamGuard: true, type: acc.steamGuardType, username: acc.username });
            } else if (acc.error) {
                sendResponse({ success: false, error: acc.error });
            } else {
                sendResponse({ success: true, username: acc.username });
            }
        }
    }, 300);
});

app.post('/api/account/qr-start', async (req, res) => {
    const sessionId = req.headers['x-session-id'] || (req.body && req.body.sid);
    if (!sessionId) return res.json({ success: false, error: 'Oturum ID gerekli' });

    try {
        const loginSession = new LoginSession(EAuthTokenPlatformType.SteamClient);
        const qrSessionId = 'qr_' + Math.random().toString(36).substring(2) + Date.now().toString(36);

        const { qrChallengeUrl } = await loginSession.startWithQR();
        const qrDataUrl = await QRCode.toDataURL(qrChallengeUrl, { margin: 2, width: 260 });

        const sessionState = {
            sessionId,
            qrSessionId,
            loginSession,
            authenticated: false,
            username: null,
            error: null,
            createdAt: Date.now()
        };

        pendingQrSessions.set(qrSessionId, sessionState);

        loginSession.on('authenticated', async () => {
            try {
                const steamID64 = loginSession.steamID ? loginSession.steamID.getSteamID64() : null;
                const username = loginSession.accountName || (steamID64 ? `user_${steamID64.substring(10)}` : 'steam_user');

                console.log(`✅ [QR Login] Steam Mobil QR Taraması Başarılı! Kullanıcı: ${username}`);

                const acc = getOrCreateAccount(sessionId, username);
                acc.error = null;
                acc.steamGuardNeeded = false;
                if (loginSession.accountName) acc.username = loginSession.accountName;

                const client = createSteamClientForAccount(acc);
                client.logOn({
                    refreshToken: loginSession.refreshToken
                });

                sessionState.authenticated = true;
                sessionState.username = username;
            } catch (e) {
                console.error('QR Login işlenirken hata:', e);
                sessionState.error = e.message;
            }
        });

        loginSession.on('timeout', () => {
            sessionState.error = 'QR Kod zaman aşımına uğradı. Yeniden kod oluşturun.';
        });

        loginSession.on('error', (err) => {
            sessionState.error = err.message || 'QR Giriş hatası';
        });

        res.json({ success: true, qrSessionId, qrDataUrl });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/account/qr-status', (req, res) => {
    const { qrSessionId } = req.query;
    if (!qrSessionId || !pendingQrSessions.has(qrSessionId)) {
        return res.json({ success: false, error: 'QR Oturumu bulunamadı veya süresi doldu' });
    }

    const state = pendingQrSessions.get(qrSessionId);
    if (state.authenticated) {
        pendingQrSessions.delete(qrSessionId);
        return res.json({ success: true, authenticated: true, username: state.username });
    } else if (state.error) {
        pendingQrSessions.delete(qrSessionId);
        return res.json({ success: false, error: state.error });
    }

    res.json({ success: true, authenticated: false });
});

app.post('/api/account/steamguard', (req, res) => {
    const sessionId = req.headers['x-session-id'] || (req.body && req.body.sid);
    const { username, code } = req.body || {};

    if (!sessionId || !username || !code) {
        return res.json({ success: false, error: 'Eksik bilgi' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);

    if (!acc || !acc.pendingSteamGuardCallback) {
        return res.json({ success: false, error: 'Geçersiz veya zamanı dolmuş Steam Guard isteği' });
    }

    acc.steamGuardNeeded = false;
    acc.pendingSteamGuardCallback(code);
    acc.pendingSteamGuardCallback = null;

    let responded = false;
    const sendResponse = (payload) => {
        if (responded || res.headersSent) return;
        responded = true;
        clearTimeout(timeout);
        clearInterval(checkInterval);
        res.json(payload);
    };

    const timeout = setTimeout(() => {
        if (acc.loggedIn) {
            sendResponse({ success: true, username: acc.username });
        } else {
            sendResponse({ success: false, error: acc.error || 'Giriş başarısız' });
        }
    }, 8000);

    const checkInterval = setInterval(() => {
        if (acc.loggedIn || acc.error) {
            if (acc.loggedIn) {
                sendResponse({ success: true, username: acc.username });
            } else {
                sendResponse({ success: false, error: acc.error });
            }
        }
    }, 500);
});

app.post('/api/account/nickname', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, nickname } = req.body;

    if (!sessionId || !username) {
        return res.json({ success: false, error: 'Oturum ve kullanıcı adı gerekli' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);
    if (acc) {
        acc.nickname = nickname ? sanitizeInput(nickname).substring(0, 30) : null;
        return res.json({ success: true, nickname: acc.nickname });
    }
    res.json({ success: false, error: 'Hesap bulunamadı' });
});

app.post('/api/account/personastate', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, personaState } = req.body;

    if (!sessionId || !username || personaState === undefined) {
        return res.json({ success: false, error: 'Eksik parametre' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);
    if (acc && acc.client && acc.loggedIn) {
        const pState = Math.min(Math.max(Number(personaState) || 1, 0), 7);
        acc.personaState = pState;
        try {
            acc.client.setPersona(pState);
            return res.json({ success: true, personaState: acc.personaState });
        } catch (e) {
            return res.json({ success: false, error: e.message });
        }
    }
    res.json({ success: false, error: 'Hesap çevrimiçi değil' });
});

app.post('/api/session/idle-all', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { appIds } = req.body;

    if (!sessionId) return res.json({ success: false, error: 'Oturum ID gerekli' });

    const keys = sessionAccounts.get(sessionId) || new Set();
    const ids = (appIds && Array.isArray(appIds) && appIds.length > 0)
        ? appIds.slice(0, 32).map(id => Math.abs(parseInt(id) || 730))
        : [730];

    let startedCount = 0;
    for (const key of keys) {
        const acc = accounts.get(key);
        if (acc && acc.loggedIn && acc.client) {
            try {
                acc.client.gamesPlayed(ids);
                acc.games = ids;
                acc.startTime = Date.now();
                startedCount++;
            } catch (e) {}
        }
    }

    res.json({ success: true, count: startedCount, games: ids });
});

app.post('/api/session/stop-all', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    if (!sessionId) return res.json({ success: false, error: 'Oturum ID gerekli' });

    const keys = sessionAccounts.get(sessionId) || new Set();
    let stoppedCount = 0;
    for (const key of keys) {
        const acc = accounts.get(key);
        if (acc && acc.loggedIn && acc.client) {
            try {
                acc.client.gamesPlayed([]);
                acc.games = [];
                stoppedCount++;
            } catch (e) {}
        }
    }

    res.json({ success: true, count: stoppedCount });
});

app.post('/api/account/idle', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, appIds } = req.body;

    if (!sessionId || !username) {
        return res.json({ success: false, error: 'Oturum ve kullanıcı adı gerekli' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);

    if (!acc || !acc.loggedIn || !acc.client) {
        return res.json({ success: false, error: 'Hesap çevrimiçi değil, önce giriş yapın' });
    }

    if (!appIds || !Array.isArray(appIds) || appIds.length === 0) {
        return res.json({ success: false, error: 'En az bir oyun seçin' });
    }

    const ids = appIds.slice(0, 32).map(id => Math.abs(parseInt(id) || 730));

    try {
        acc.client.gamesPlayed(ids);
        acc.games = ids;
        acc.startTime = Date.now();
        res.json({ success: true, games: ids });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/account/stop', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username } = req.body;

    if (sessionId && username) {
        const key = getAccountKey(sessionId, username);
        const acc = accounts.get(key);
        if (acc && acc.client && acc.loggedIn) {
            acc.client.gamesPlayed([]);
            acc.games = [];
        }
    }
    res.json({ success: true });
});

app.post('/api/account/logout', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username } = req.body;

    if (sessionId && username) {
        const key = getAccountKey(sessionId, username);
        const acc = accounts.get(key);
        if (acc) {
            if (acc.client) {
                try {
                    acc.client.gamesPlayed([]);
                    acc.client.logOff();
                } catch (e) {}
            }
            accounts.delete(key);
            if (sessionAccounts.has(sessionId)) {
                sessionAccounts.get(sessionId).delete(key);
            }
        }
    }
    res.json({ success: true });
});

app.get('/api/games', (req, res) => {
    res.json(POPULAR_GAMES);
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Bulunamadı (404)' });
});

// Global Error Handler (Sistem Çökmesini Önleme)
app.use((err, req, res, next) => {
    console.error('⚠️ Sunucu içi işlenmemiş hata:', err.stack);
    res.status(500).json({ success: false, error: 'Sunucu içi bir hata oluştu.' });
});

// ============================================================
// SUNUCUYU BAŞLAT
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║ 🛡️ STEAM IDLE PRO - ÜST DÜZEY GÜVENLİ SERVER HARDENED   ║
║ http://localhost:${PORT}                                   ║
║                                                          ║
║ 🛡️ Helmet CSP, XSS, Clickjacking, MIME Sniffing aktif    ║
║ 🛡️ Rate Limiting (DDoS & Brute Force koruması) aktif     ║
║ 🛡️ Input Sanitization & Anti-Injection koruması aktif     ║
║ 🛡️ Anti-Payload Bomb & Memory Leak protection aktif       ║
╚══════════════════════════════════════════════════════════╝
    `);
});
