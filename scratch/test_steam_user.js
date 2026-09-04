const SteamUser = require('steam-user');
console.log('SteamUser version/methods:', typeof SteamUser.prototype.logOn);

const client = new SteamUser({ promptSteamGuardCode: false, dataDirectory: null });
console.log('client created successfully');
