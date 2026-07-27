import http from 'node:http';

const port = Number(process.env.PORT || 4010);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'mock-stellar' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/accounts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ _embedded: { records: [] } }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/account') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ account_id: 'GMOCK123', sequence: '1' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/fee_stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ fee_charged: 100, max_fee: 100000 }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/transactions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', hash: 'mock-hash' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock-stellar listening on ${port}`);
});
