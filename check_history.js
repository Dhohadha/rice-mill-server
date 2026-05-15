const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/history?range=hour',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const history = JSON.parse(data);
      console.log('Latest history entry:', history[history.length - 1]);
    } catch (e) {
      console.error('Error parsing response:', e);
      console.log('Raw data:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('API Request Error:', e);
});
req.end();
