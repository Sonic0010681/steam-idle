const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

async function testGuard() {
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.on('authenticated', () => {
        console.log('Authenticated! Refresh Token:', session.refreshToken);
    });
    session.on('timeout', () => {
        console.log('Timeout');
    });
    session.on('error', (err) => {
        console.log('Session Error:', err.message);
    });
}
testGuard();
