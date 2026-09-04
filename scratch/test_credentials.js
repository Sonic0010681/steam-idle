const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

async function testCredentials() {
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    try {
        const result = await session.startWithCredentials({
            accountName: 'testuser123',
            password: 'wrongpassword123'
        });
        console.log('Result:', result);
    } catch (err) {
        console.log('Error caught:', err.message, err.eresult);
    }
}

testCredentials();
