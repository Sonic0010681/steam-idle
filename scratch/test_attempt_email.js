const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

async function testEmailAuth() {
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
    try {
        const startRes = await session.startWithCredentials({
            accountName: 'testuser123',
            password: 'wrongpassword123'
        });
        console.log('startRes:', startRes);
        if (startRes.actionRequired) {
            await session._attemptEmailCodeAuth();
            console.log('Email code auth triggered successfully!');
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
}

testEmailAuth();
