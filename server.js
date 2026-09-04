const express = require('express');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Popüler Oyunlar Kataloğu (Fallback / Ek Listeleme İçin)
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

// Multi-tenant & Çoklu Hesap Veri Yapıları
// accounts: accountKey -> Account Object
// sessionAccounts: sessionId -> Set of accountKeys
const accounts = new Map();
const sessionAccounts = new Map();
const pendingQrSessions = new Map();

function getAccountKey(sessionId, username) {
    return `${sessionId}:${username.toLowerCase()}`;
}

function getOrCreateAccount(sessionId, username) {
    const key = getAccountKey(sessionId, username);
    if (accounts.has(key)) {
        return accounts.get(key);
    }

    const acc = {
        key,
        sessionId,
        username,
        nickname: null,            // Özel takma ad (örn: "Ana Hesabım")
        persona: null,
        steamID: null,
        loggedIn: false,
        steamGuardNeeded: false,
        steamGuardType: null,
        pendingSteamGuardCallback: null,
        error: null,
        personaState: SteamUser.EPersonaState.Online, // 1: Online, 7: Invisible, 3: Away, 4: Busy
        games: [],                 // Kasılan appId'ler
        ownedGames: [],            // Sahip olunan oyunlar
        startTime: null,
        totalIdleSeconds: 0,       // Toplam idle süresi (saniye)
        dailySeconds: 0,           // Günlük idle süresi (saniye)
        weeklySeconds: 0,          // Haftalık idle süresi (saniye)
        monthlySeconds: 0,         // Aylık idle süresi (saniye)
        client: null
    };

    accounts.set(key, acc);

    if (!sessionAccounts.has(sessionId)) {
        sessionAccounts.set(sessionId, new Set());
    }
    sessionAccounts.get(sessionId).add(key);

    return acc;
}

// 1 Saniyelik ZAMAN SÜRESİ İLERLETME SAYAÇI (Analiz & Saat Takibi)
setInterval(() => {
    for (const acc of accounts.values()) {
        if (acc.loggedIn && acc.games && acc.games.length > 0) {
            acc.totalIdleSeconds = (acc.totalIdleSeconds || 0) + 1;
            acc.dailySeconds = (acc.dailySeconds || 0) + 1;
            acc.weeklySeconds = (acc.weeklySeconds || 0) + 1;
            acc.monthlySeconds = (acc.monthlySeconds || 0) + 1;
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

    // Başarılı giriş
    client.on('loggedOn', (details) => {
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

    // Kullanıcı takma adı
    client.on('accountInfo', (name) => {
        acc.persona = name;
    });

    // Steam Guard gerekli
    client.on('steamGuard', (domain, callback) => {
        console.log(`🔐 [${acc.username}] Steam Guard kodu bekleniyor (${domain ? 'e-posta: ' + domain : 'mobil uygulama'})`);
        acc.steamGuardNeeded = true;
        acc.steamGuardType = domain ? 'email' : 'app';
        acc.pendingSteamGuardCallback = callback;
    });

    // Sahip olunan oyun lisansları ve PICS önbelleği yüklendiğinde
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
                        name = appInfo.common.name;
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

    // Hata oluştu
    client.on('error', (err) => {
        console.error(`❌ [${acc.username}] Steam hatası:`, err.message);
        acc.loggedIn = false;
        acc.games = [];
        acc.error = getSteamErrorMessage(err);
    });

    // Bağlantı kesildi
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

// Oturuma ait tüm hesapların durum listesini ve liderlik sıralamasını getir
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

// Belirli bir hesabın detaylı durumunu getir
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
        ownedGames: acc.ownedGames,
        totalIdleSeconds: acc.totalIdleSeconds,
        dailySeconds: acc.dailySeconds,
        weeklySeconds: acc.weeklySeconds,
        monthlySeconds: acc.monthlySeconds,
        uptime
    });
});

// Giriş Yap (Kullanıcı Adı & Şifre)
app.post('/api/account/login', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, password } = req.body;

    if (!sessionId || !username || !password) {
        return res.json({ success: false, error: 'Kullanıcı adı ve şifre gerekli' });
    }

    const acc = getOrCreateAccount(sessionId, username);
    acc.error = null;
    acc.steamGuardNeeded = false;

    const client = createSteamClientForAccount(acc);
    client.logOn({
        accountName: username,
        password: password
    });

    let responded = false;
    const sendResponse = (payload) => {
        if (responded || res.headersSent) return;
        responded = true;
        clearTimeout(timeout);
        clearInterval(checkInterval);
        res.json(payload);
    };

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
            } else {
                sendResponse({ success: true, username: acc.username });
            }
        }
    }, 500);
});

// FEATURE: QR KOD İLE STEAM MOBİL GİRİŞİ BAŞLAT
app.post('/api/account/qr-start', async (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
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
            error: null
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

// FEATURE: QR GİRİŞ DURUMUNU SORGULA
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

// Steam Guard Doğrula
app.post('/api/account/steamguard', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, code } = req.body;

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

// Özel Takma Ad (Nickname) Belirle
app.post('/api/account/nickname', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, nickname } = req.body;

    if (!sessionId || !username) {
        return res.json({ success: false, error: 'Oturum ve kullanıcı adı gerekli' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);
    if (acc) {
        acc.nickname = nickname ? nickname.trim() : null;
        return res.json({ success: true, nickname: acc.nickname });
    }
    res.json({ success: false, error: 'Hesap bulunamadı' });
});

// Steam Durum Modu Değiştir (Çevrimiçi / Görünmez (Invisible) / Dışarıda / Meşgul)
app.post('/api/account/personastate', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username, personaState } = req.body;

    if (!sessionId || !username || personaState === undefined) {
        return res.json({ success: false, error: 'Eksik parametre' });
    }

    const key = getAccountKey(sessionId, username);
    const acc = accounts.get(key);
    if (acc && acc.client && acc.loggedIn) {
        acc.personaState = Number(personaState);
        try {
            acc.client.setPersona(acc.personaState);
            console.log(`🥷 [${acc.username}] Steam Durumu güncellendi: ${acc.personaState}`);
            return res.json({ success: true, personaState: acc.personaState });
        } catch (e) {
            return res.json({ success: false, error: e.message });
        }
    }
    res.json({ success: false, error: 'Hesap çevrimiçi değil' });
});

// MASTER CONTROL 1: TEK TIKLA TÜM HESAPLARDA IDLE BAŞLAT
app.post('/api/session/idle-all', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { appIds } = req.body;

    if (!sessionId) return res.json({ success: false, error: 'Oturum ID gerekli' });

    const keys = sessionAccounts.get(sessionId) || new Set();
    const ids = (appIds && Array.isArray(appIds) && appIds.length > 0) ? appIds.slice(0, 32).map(Number) : [730];

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

    console.log(`🚀 [Master Control] ${startedCount} adet hesapta toplu idle başlatıldı: ${ids.join(', ')}`);
    res.json({ success: true, count: startedCount, games: ids });
});

// MASTER CONTROL 2: TEK TIKLA TÜM HESAPLARDA IDLE DURDUR
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

    console.log(`⏹ [Master Control] ${stoppedCount} adet hesapta idle durduruldu.`);
    res.json({ success: true, count: stoppedCount });
});

// Idle Başlat (Tekil)
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

    const ids = appIds.slice(0, 32).map(Number);

    try {
        acc.client.gamesPlayed(ids);
        acc.games = ids;
        acc.startTime = Date.now();
        console.log(`🎮 [${acc.username}] Idle başlatıldı! Oyunlar: ${ids.join(', ')}`);
        res.json({ success: true, games: ids });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Idle Durdur (Tekil)
app.post('/api/account/stop', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sid;
    const { username } = req.body;

    if (sessionId && username) {
        const key = getAccountKey(sessionId, username);
        const acc = accounts.get(key);
        if (acc && acc.client && acc.loggedIn) {
            acc.client.gamesPlayed([]);
            acc.games = [];
            console.log(`⏹ [${acc.username}] Idle durduruldu.`);
        }
    }
    res.json({ success: true });
});

// Hesaptan Çıkış Yap / Kaldır
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
            console.log(`👋 [${username}] Hesaptan çıkış yapıldı ve listeden kaldırıldı.`);
        }
    }
    res.json({ success: true });
});

// Genel Popüler Oyunlar Kataloğu
app.get('/api/games', (req, res) => {
    res.json(POPULAR_GAMES);
});

// ============================================================
// SUNUCUYU BAŞLAT
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║ 🎮 STEAM IDLE PRO MASTER - SAAT KASICI & ANALİZ          ║
║ http://localhost:${PORT}                                   ║
║                                                          ║
║ ⚡ 📲 STEAM MOBİL UYGULAMASIYLA QR KOD İLE GİRİŞ DESTEĞİ! ║
║ ⚡ 1. Tek Tıkla Tüm Hesaplarda Saat Kasma (Master)       ║
║ ⚡ 3. Görünmez (Invisible) & Gizli Modda Saat Kasma      ║
║ ⚡ 🎨 RGB / Cyberpunk / Synthwave Temaları               ║
║ ⚡ 📊 Günlük/Haftalık/Aylık/Yıllık Saat Analizi          ║
║ ⚡ 🏆 Canlı Liderlik Tablosu (En çok saat kasan 1.)       ║
╚══════════════════════════════════════════════════════════╝
    `);
});
