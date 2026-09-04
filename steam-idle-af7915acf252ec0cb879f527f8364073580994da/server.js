const express = require('express');
const SteamUser = require('steam-user');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// STEAM CLIENT YÖNETİMİ
// ============================================================
let steamClient = null;
let sessionState = {
    loggedIn: false,
    username: '',
    games: [],
    steamGuardNeeded: false,
    steamGuardType: null, // 'email' veya 'app'
    error: null,
    persona: null,
    startTime: null
};

// Bekleyen Steam Guard callback
let pendingSteamGuardCallback = null;

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

function createSteamClient() {
    if (steamClient) {
        try { steamClient.logOff(); } catch (e) {}
    }

    steamClient = new SteamUser({
        promptSteamGuardCode: false,  // Manuel olarak yöneteceğiz
        dataDirectory: null           // Veri kaydetme (güvenlik)
    });

    // Başarılı giriş
    steamClient.on('loggedOn', (details) => {
        console.log(`✅ Steam giriş başarılı: ${steamClient.steamID}`);
        sessionState.loggedIn = true;
        sessionState.steamGuardNeeded = false;
        sessionState.error = null;
        sessionState.startTime = Date.now();

        // Online görün
        steamClient.setPersona(SteamUser.EPersonaState.Online);
    });

    // Kullanıcı bilgileri
    steamClient.on('accountInfo', (name, country) => {
        sessionState.persona = name;
    });

    // Steam Guard kodu gerekli
    steamClient.on('steamGuard', (domain, callback) => {
        console.log(`🔐 Steam Guard kodu gerekli (${domain ? 'e-posta: ' + domain : 'mobil uygulama'})`);
        sessionState.steamGuardNeeded = true;
        sessionState.steamGuardType = domain ? 'email' : 'app';
        pendingSteamGuardCallback = callback;
    });

    // Hata
    steamClient.on('error', (err) => {
        console.error('❌ Steam hatası:', err.message);
        sessionState.loggedIn = false;
        sessionState.games = [];
        sessionState.error = getSteamErrorMessage(err);
    });

    // Bağlantı kesildi
    steamClient.on('disconnected', (eresult, msg) => {
        console.log('🔌 Steam bağlantısı kesildi:', msg);
        sessionState.loggedIn = false;
        sessionState.games = [];
    });

    return steamClient;
}

function getSteamErrorMessage(err) {
    const messages = {
        61: 'Geçersiz şifre',
        63: 'Hesap kilitlendı - çok fazla hatalı giriş',
        65: 'Steam Guard kodu geçersiz',
        66: 'Steam Guard kodu gerekli',
        84: 'Rate limit - biraz bekle ve tekrar dene',
        5: 'Geçersiz şifre',
    };
    return messages[err.eresult] || err.message || 'Bilinmeyen hata';
}

// ============================================================
// API ROUTES
// ============================================================

// Durum sorgula
app.get('/api/status', (req, res) => {
    const uptime = sessionState.startTime
        ? Math.floor((Date.now() - sessionState.startTime) / 1000)
        : 0;

    res.json({
        loggedIn: sessionState.loggedIn,
        username: sessionState.username,
        persona: sessionState.persona,
        games: sessionState.games,
        steamGuardNeeded: sessionState.steamGuardNeeded,
        steamGuardType: sessionState.steamGuardType,
        error: sessionState.error,
        uptime: uptime
    });
});

// Giriş yap
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, error: 'Kullanıcı adı ve şifre gerekli' });
    }

    sessionState.username = username;
    sessionState.error = null;
    sessionState.steamGuardNeeded = false;

    const client = createSteamClient();

    client.logOn({
        accountName: username,
        password: password
    });

    // Cevabı biraz bekle
    const timeout = setTimeout(() => {
        if (sessionState.steamGuardNeeded) {
            res.json({ success: false, steamGuard: true, type: sessionState.steamGuardType });
        } else if (sessionState.error) {
            res.json({ success: false, error: sessionState.error });
        } else if (sessionState.loggedIn) {
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Bağlantı zaman aşımına uğradı' });
        }
    }, 10000);

    // Erken cevap ver
    const checkInterval = setInterval(() => {
        if (sessionState.loggedIn || sessionState.error || sessionState.steamGuardNeeded) {
            clearTimeout(timeout);
            clearInterval(checkInterval);

            if (sessionState.steamGuardNeeded) {
                res.json({ success: false, steamGuard: true, type: sessionState.steamGuardType });
            } else if (sessionState.error) {
                res.json({ success: false, error: sessionState.error });
            } else {
                res.json({ success: true });
            }
        }
    }, 500);
});

// Steam Guard kodu gönder
app.post('/api/steamguard', (req, res) => {
    const { code } = req.body;

    if (!code || !pendingSteamGuardCallback) {
        return res.json({ success: false, error: 'Geçersiz kod veya oturum' });
    }

    sessionState.steamGuardNeeded = false;
    pendingSteamGuardCallback(code);
    pendingSteamGuardCallback = null;

    // Giriş sonucunu bekle
    const timeout = setTimeout(() => {
        if (sessionState.loggedIn) {
            res.json({ success: true });
        } else {
            res.json({ success: false, error: sessionState.error || 'Giriş başarısız' });
        }
    }, 8000);

    const checkInterval = setInterval(() => {
        if (sessionState.loggedIn || sessionState.error) {
            clearTimeout(timeout);
            clearInterval(checkInterval);

            if (sessionState.loggedIn) {
                res.json({ success: true });
            } else {
                res.json({ success: false, error: sessionState.error });
            }
        }
    }, 500);
});

// Oyun idle başlat
app.post('/api/idle', (req, res) => {
    const { appIds } = req.body;

    if (!sessionState.loggedIn || !steamClient) {
        return res.json({ success: false, error: 'Önce giriş yap' });
    }

    if (!appIds || !Array.isArray(appIds) || appIds.length === 0) {
        return res.json({ success: false, error: 'En az bir oyun seç' });
    }

    // Steam aynı anda max 32 oyun destekler
    const ids = appIds.slice(0, 32).map(Number);

    try {
        steamClient.gamesPlayed(ids);
        sessionState.games = ids;
        sessionState.startTime = Date.now();
        console.log(`🎮 Idle başlatıldı: ${ids.join(', ')}`);
        res.json({ success: true, games: ids });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Idle durdur
app.post('/api/stop', (req, res) => {
    if (steamClient && sessionState.loggedIn) {
        steamClient.gamesPlayed([]);
        sessionState.games = [];
        console.log('⏹ Idle durduruldu');
    }
    res.json({ success: true });
});

// Çıkış yap
app.post('/api/logout', (req, res) => {
    if (steamClient) {
        try {
            steamClient.gamesPlayed([]);
            steamClient.logOff();
        } catch (e) {}
    }

    sessionState = {
        loggedIn: false, username: '', games: [],
        steamGuardNeeded: false, steamGuardType: null,
        error: null, persona: null, startTime: null
    };

    console.log('👋 Çıkış yapıldı');
    res.json({ success: true });
});

// Oyun listesi
app.get('/api/games', (req, res) => {
    res.json(POPULAR_GAMES);
});

// ============================================================
// SUNUCUYU BAŞLAT
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║     🎮 STEAM IDLE - Saati Kas!          ║
║     http://localhost:${PORT}               ║
║                                          ║
║     PC'ni kapat, saat kasılmaya          ║
║     devam etsin!                         ║
╚══════════════════════════════════════════╝
    `);
});
