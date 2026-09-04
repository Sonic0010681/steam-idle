const http = require('http');

const data = JSON.stringify({
    username: 'testuser123',
    password: 'wrongpassword123'
});

const req = http.request({
    hostname: 'localhost',
    port: 5000,
    path: '/api/account/login',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'x-session-id': 'test_session_999'
    }
}, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Status Code:', res.statusCode);
        console.log('Response Body:', body);
    });
});

req.on('error', (e) => {
    console.error('Error:', e);
});

req.write(data);
req.end();
