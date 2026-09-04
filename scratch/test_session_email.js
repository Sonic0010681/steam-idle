const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

console.log('LoginSession prototype keys:', Object.keys(LoginSession.prototype));
for (const key of Object.getOwnPropertyNames(LoginSession.prototype)) {
    console.log(' - ', key);
}
