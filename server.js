const express = require('express');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// KALICI OTURUM YÖNETİMİ (SESSIONS.JSON)
// ============================================================
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function saveAccountSession(username, refreshToken) {
    if (!username || !refreshToken) return;
    let data = {};
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        }
    } catch (e) {}
    data[username.toLowerCase()] = { username, refreshToken, lastSaved: Date.now() };
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

function removeAccountSession(username) {
    if (!username) return;
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            delete data[username.toLowerCase()];
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
        }
    } catch (e) {}
}

// ============================================================
// ÇOKLU HESAP & OTURUM VERİ YAPILARI
// ============================================================
const accounts = new Map(); // username.toLowerCase() -> account state
const pendingQrSessions = new Map(); // qrSessionId -> state

// Popüler oyunlar listesi
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

function getOrCreateAccount(rawUsername) {
    const cleanUser = String(rawUsername).trim();
    const key = cleanUser.toLowerCase();

    if (accounts.has(key)) {
        return accounts.get(key);
    }

    const acc = {
        key,
        username: cleanUser,
        persona: null,
        steamID: null,
        loggedIn: false,
        games: [],
        ownedGames: [],
        steamGuardNeeded: false,
        steamGuardType: null,
        pendingSteamGuardCallback: null,
        error: null,
        startTime: null,
        totalSeconds: 0,
        client: null
    };

    accounts.set(key, acc);
    return acc;
}

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

        try {
            client.setPersona(SteamUser.EPersonaState.Online);
        } catch (e) {}

        if (acc.games && acc.games.length > 0) {
            acc.startTime = Date.now();
            try { client.gamesPlayed(acc.games, true); } catch (e) {}
        } else {
            acc.startTime = null;
        }
    });

    client.on('accountInfo', (name) => {
        acc.persona = name;
    });

    client.on('refreshToken', (token) => {
        console.log(`🔑 [${acc.username}] Yeni oturum anahtarı kaydedildi`);
        saveAccountSession(acc.username, token);
    });

    client.on('playingState', (blocked, playingApp) => {
        console.log(`🎮 [${acc.username}] Oynama durumu: blocked=${blocked}, playingApp=${playingApp}`);
    });

    client.on('appLaunched', (appid) => {
        console.log(`🚀 [${acc.username}] Steam oyunu onayladı ve başlattı: AppID ${appid}`);
    });

    client.on('appQuit', (appid) => {
        console.log(`🛑 [${acc.username}] Steam oyunu durduruldu: AppID ${appid}`);
    });

    client.on('ownershipCached', () => {
        try {
            const ownedAppIds = client.getOwnedApps() || [];
            console.log(`📦 [${acc.username}] ${ownedAppIds.length} adet lisans/oyun tespit edildi.`);
            const list = [];
            ownedAppIds.forEach(appId => {
                const idNum = Number(appId);
                const pop = POPULAR_GAMES.find(g => g.appId === idNum);
                let name = pop ? pop.name : null;
                if (!name && client.picsCache && client.picsCache.apps && client.picsCache.apps[idNum]) {
                    const info = client.picsCache.apps[idNum].appinfo;
                    if (info && info.common && info.common.name) name = info.common.name;
                }
                list.push({ appId: idNum, name: name || `Oyun #${idNum}` });
            });
            acc.ownedGames = list;
        } catch (e) {}
    });

    client.on('steamGuard', (domain, callback) => {
        console.log(`🔐 [${acc.username}] Steam Guard kodu gerekli (${domain ? 'e-posta: ' + domain : 'mobil uygulama'})`);
        acc.steamGuardNeeded = true;
        acc.steamGuardType = domain ? 'email' : 'app';
        acc.pendingSteamGuardCallback = callback;
    });

    client.on('error', (err) => {
        console.error(`❌ [${acc.username}] Steam hatası:`, err.message);
        acc.loggedIn = false;
        acc.games = [];
        acc.startTime = null;
        acc.error = getSteamErrorMessage(err);
    });

    client.on('disconnected', (eresult, msg) => {
        console.log(`🔌 [${acc.username}] Steam bağlantısı kesildi:`, msg);
        acc.loggedIn = false;
        acc.games = [];
        acc.startTime = null;
    });

    return client;
}

function getSteamErrorMessage(err) {
    const messages = {
        61: 'Geçersiz şifre',
        63: 'Hesap kilitlendi - çok fazla hatalı giriş',
        65: 'Steam Guard kodu geçersiz',
        66: 'Steam Guard kodu gerekli',
        84: 'Rate limit - biraz bekle ve tekrar dene',
        5: 'Geçersiz şifre',
    };
    return messages[err.eresult] || err.message || 'Bilinmeyen hata';
}

// Sayaç & Bellek temizleyici (Saniyede bir)
setInterval(() => {
    for (const acc of accounts.values()) {
        if (acc.loggedIn && acc.games && acc.games.length > 0) {
            acc.totalSeconds = (acc.totalSeconds || 0) + 1;
        }
    }

    const now = Date.now();
    for (const [id, state] of pendingQrSessions.entries()) {
        if (state.createdAt && (now - state.createdAt > 180000)) {
            pendingQrSessions.delete(id);
        }
    }
}, 1000);

function loadSavedSessions() {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return;
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        for (const [key, sess] of Object.entries(data)) {
            if (sess && sess.refreshToken && sess.username) {
                console.log(`🔄 Kayıtlı oturum geri yükleniyor: ${sess.username}`);
                const acc = getOrCreateAccount(sess.username);
                const client = createSteamClientForAccount(acc);
                client.logOn({ refreshToken: sess.refreshToken });
            }
        }
    } catch (e) {
        console.error('Kayıtlı oturumlar yüklenirken hata:', e.message);
    }
}

// ============================================================
// API ROUTES
// ============================================================

// 1. Tüm hesapları listele
app.get('/api/accounts', (req, res) => {
    const list = [];
    for (const acc of accounts.values()) {
        const uptime = (acc.startTime && acc.games && acc.games.length > 0)
            ? Math.floor((Date.now() - acc.startTime) / 1000)
            : 0;
        list.push({
            username: acc.username,
            persona: acc.persona || acc.username,
            steamID: acc.steamID,
            loggedIn: acc.loggedIn,
            steamGuardNeeded: acc.steamGuardNeeded,
            steamGuardType: acc.steamGuardType,
            games: acc.games || [],
            ownedGamesCount: acc.ownedGames ? acc.ownedGames.length : 0,
            error: acc.error,
            uptime: uptime,
            totalSeconds: acc.totalSeconds || 0
        });
    }
    res.json({ success: true, accounts: list });
});

// 2. Tek bir hesabın detaylı durumunu al
app.get('/api/status', (req, res) => {
    const username = req.query.username;

    if (!username) {
        const first = accounts.values().next().value;
        if (!first) {
            return res.json({ loggedIn: false, accountsCount: 0 });
        }
        const uptime = (first.startTime && first.games && first.games.length > 0)
            ? Math.floor((Date.now() - first.startTime) / 1000)
            : 0;
        return res.json({
            loggedIn: first.loggedIn,
            username: first.username,
            persona: first.persona || first.username,
            steamID: first.steamID,
            games: first.games || [],
            ownedGames: (first.ownedGames && first.ownedGames.length > 0) ? first.ownedGames : POPULAR_GAMES,
            steamGuardNeeded: first.steamGuardNeeded,
            steamGuardType: first.steamGuardType,
            error: first.error,
            uptime: uptime,
            totalSeconds: first.totalSeconds || 0,
            accountsCount: accounts.size
        });
    }

    const key = String(username).toLowerCase().trim();
    const acc = accounts.get(key);
    if (!acc) {
        return res.json({ success: false, error: 'Hesap bulunamadı' });
    }

    const uptime = (acc.startTime && acc.games && acc.games.length > 0)
        ? Math.floor((Date.now() - acc.startTime) / 1000)
        : 0;
    res.json({
        success: true,
        loggedIn: acc.loggedIn,
        username: acc.username,
        persona: acc.persona || acc.username,
        steamID: acc.steamID,
        games: acc.games || [],
        ownedGames: (acc.ownedGames && acc.ownedGames.length > 0) ? acc.ownedGames : POPULAR_GAMES,
        steamGuardNeeded: acc.steamGuardNeeded,
        steamGuardType: acc.steamGuardType,
        error: acc.error,
        uptime: uptime,
        totalSeconds: acc.totalSeconds || 0,
        accountsCount: accounts.size
    });
});

// 3. QR Kod Oturumu Başlat
app.post('/api/qr-start', async (req, res) => {
    try {
        const loginSession = new LoginSession(EAuthTokenPlatformType.SteamClient);
        const qrSessionId = 'qr_' + Math.random().toString(36).substring(2) + Date.now().toString(36);

        const { qrChallengeUrl } = await loginSession.startWithQR();
        const qrDataUrl = await QRCode.toDataURL(qrChallengeUrl, { margin: 2, width: 240 });

        const sessionState = {
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

                const acc = getOrCreateAccount(username);
                acc.error = null;
                acc.steamGuardNeeded = false;
                if (loginSession.accountName) acc.username = loginSession.accountName;

                saveAccountSession(acc.username, loginSession.refreshToken);

                const client = createSteamClientForAccount(acc);
                client.logOn({ refreshToken: loginSession.refreshToken });

                sessionState.authenticated = true;
                sessionState.username = acc.username;
            } catch (e) {
                console.error('QR Login hatası:', e);
                sessionState.error = e.message;
            }
        });

        loginSession.on('timeout', () => {
            sessionState.error = 'QR Kod zaman aşımına uğradı. Yeniden oluşturun.';
        });

        loginSession.on('error', (err) => {
            sessionState.error = err.message || 'QR Giriş hatası';
        });

        res.json({ success: true, qrSessionId, qrDataUrl });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 4. QR Kod Durumunu Sorgula
app.get('/api/qr-status', (req, res) => {
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

// 5. Normal Şifre ile Giriş Yap
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, error: 'Kullanıcı adı ve şifre gerekli' });
    }

    const acc = getOrCreateAccount(username);
    acc.error = null;
    acc.steamGuardNeeded = false;
    acc.pendingSteamGuardCallback = null;

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

    client.once('steamGuard', (domain, callback) => {
        acc.steamGuardNeeded = true;
        acc.steamGuardType = domain ? 'email' : 'app';
        acc.pendingSteamGuardCallback = callback;
        sendResponse({ success: false, steamGuard: true, type: acc.steamGuardType, username: acc.username });
    });

    client.once('error', (err) => {
        acc.error = getSteamErrorMessage(err);
        sendResponse({ success: false, error: acc.error });
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
            sendResponse({ success: false, error: 'Bağlantı zaman aşımına uğradı' });
        }
    }, 10000);

    const checkInterval = setInterval(() => {
        if (acc.loggedIn || acc.error || acc.steamGuardNeeded) {
            if (acc.steamGuardNeeded) {
                sendResponse({ success: false, steamGuard: true, type: acc.steamGuardType, username: acc.username });
            } else if (acc.error) {
                sendResponse({ success: false, error: acc.error });
            } else if (acc.loggedIn) {
                sendResponse({ success: true, username: acc.username });
            }
        }
    }, 300);
});

// 6. Steam Guard Doğrula
app.post('/api/steamguard', (req, res) => {
    const { username, code } = req.body;

    let targetAcc = null;
    if (username) {
        targetAcc = accounts.get(String(username).toLowerCase().trim());
    } else {
        for (const acc of accounts.values()) {
            if (acc.steamGuardNeeded && acc.pendingSteamGuardCallback) {
                targetAcc = acc;
                break;
            }
        }
    }

    if (!targetAcc || !code || !targetAcc.pendingSteamGuardCallback) {
        return res.json({ success: false, error: 'Geçersiz kod veya bekleyen guard oturumu yok' });
    }

    targetAcc.steamGuardNeeded = false;
    targetAcc.pendingSteamGuardCallback(String(code).trim().toUpperCase());
    targetAcc.pendingSteamGuardCallback = null;

    const timeout = setTimeout(() => {
        if (targetAcc.loggedIn) {
            res.json({ success: true, username: targetAcc.username });
        } else {
            res.json({ success: false, error: targetAcc.error || 'Giriş başarısız' });
        }
    }, 8000);

    const checkInterval = setInterval(() => {
        if (targetAcc.loggedIn || targetAcc.error) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            if (targetAcc.loggedIn) {
                res.json({ success: true, username: targetAcc.username });
            } else {
                res.json({ success: false, error: targetAcc.error });
            }
        }
    }, 300);
});

// 7. Tek bir hesapta oyun idle başlat
app.post('/api/idle', (req, res) => {
    const { username, appIds } = req.body;

    let acc = null;
    if (username) {
        acc = accounts.get(String(username).toLowerCase().trim());
    } else {
        acc = accounts.values().next().value;
    }

    if (!acc || !acc.loggedIn || !acc.client) {
        return res.json({ success: false, error: 'Önce geçerli bir hesapla giriş yap' });
    }

    let ids = [];
    if (appIds && Array.isArray(appIds) && appIds.length > 0) {
        ids = appIds.slice(0, 32).map(Number);
    } else {
        ids = [730]; // Varsayılan CS2
    }

    try {
        try {
            acc.client.setPersona(SteamUser.EPersonaState.Online);
        } catch (e) {}

        acc.client.gamesPlayed(ids, true);
        acc.games = ids;
        acc.startTime = Date.now();
        console.log(`🎮 [${acc.username}] Idle başlatıldı: ${ids.join(', ')}`);
        res.json({ success: true, games: ids, username: acc.username });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 8. Tek bir hesapta idle durdur
app.post('/api/stop', (req, res) => {
    const { username } = req.body;

    let acc = null;
    if (username) {
        acc = accounts.get(String(username).toLowerCase().trim());
    } else {
        acc = accounts.values().next().value;
    }

    if (acc && acc.client && acc.loggedIn) {
        acc.client.gamesPlayed([]);
        acc.games = [];
        acc.startTime = null;
        console.log(`⏹ [${acc.username}] Idle durduruldu`);
    }
    res.json({ success: true });
});

// 9. Tüm hesaplarda idle başlat
app.post('/api/idle-all', (req, res) => {
    const { appIds } = req.body;
    const ids = (appIds && Array.isArray(appIds) && appIds.length > 0)
        ? appIds.slice(0, 32).map(Number)
        : [730];

    let count = 0;
    for (const acc of accounts.values()) {
        if (acc.loggedIn && acc.client) {
            try {
                try {
                    acc.client.setPersona(SteamUser.EPersonaState.Online);
                } catch (e) {}
                acc.client.gamesPlayed(ids, true);
                acc.games = ids;
                acc.startTime = Date.now();
                count++;
            } catch (e) {}
        }
    }
    res.json({ success: true, count, games: ids });
});

// 10. Tüm hesaplarda idle durdur
app.post('/api/stop-all', (req, res) => {
    let count = 0;
    for (const acc of accounts.values()) {
        if (acc.loggedIn && acc.client) {
            try {
                acc.client.gamesPlayed([]);
                acc.games = [];
                acc.startTime = null;
                count++;
            } catch (e) {}
        }
    }
    res.json({ success: true, count });
});

// 11. Hesabı Çıkart / Kaldır
app.post('/api/logout', (req, res) => {
    const { username } = req.body;
    if (username) {
        const key = String(username).toLowerCase().trim();
        const acc = accounts.get(key);
        if (acc) {
            if (acc.client) {
                try {
                    acc.client.gamesPlayed([]);
                    acc.client.logOff();
                } catch (e) {}
            }
            accounts.delete(key);
            removeAccountSession(acc.username);
            console.log(`👋 [${acc.username}] Hesabı kaldırıldı`);
        }
    }
    res.json({ success: true, accountsCount: accounts.size });
});

// 12. Popüler Oyunlar Listesi
app.get('/api/games', (req, res) => {
    res.json(POPULAR_GAMES);
});

// ============================================================
// SUNUCUYU BAŞLAT
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║     🎮 STEAM IDLE PRO - ÇOKLU HESAP + QR KOD AKTİF   ║
║     http://localhost:${PORT}                           ║
║                                                      ║
║     📱 Steam Mobil QR Tarama Hazır                   ║
║     👥 Sınırsız Çoklu Hesap Ekleme Hazır             ║
║     ⚡ PC Kapalıyken de Saat Kasmaya Devam Eder!     ║
╚══════════════════════════════════════════════════════╝
    `);
    loadSavedSessions();
});
