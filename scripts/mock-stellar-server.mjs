import http from 'node:http';

const port = Number(process.env.PORT || 4010);

// Fault injection configuration
const FAULT_INJECTION_ENABLED = process.env.FAULT_INJECTION_ENABLED === 'true';
const FAULT_LATENCY_MS = Number(process.env.FAULT_LATENCY_MS || '0');
const FAULT_ERROR_RATE = Number(process.env.FAULT_ERROR_RATE || '0');
const FAULT_TIMEOUT_RATE = Number(process.env.FAULT_TIMEOUT_RATE || '0');
const FAULT_MALFORMED_RATE = Number(process.env.FAULT_MALFORMED_RATE || '0');

// Privacy-safe logging (no sensitive data)
function logFault(type, details) {
  if (FAULT_INJECTION_ENABLED) {
    console.error(`[FAULT_INJECTION] ${type}: ${JSON.stringify(details)}`);
  }
}

// Apply fault injection to response
async function applyFaults(req, res, endpoint) {
  if (!FAULT_INJECTION_ENABLED) return false;

  const random = Math.random();

  // Latency injection
  if (FAULT_LATENCY_MS > 0 && random < (FAULT_LATENCY_MS > 0 ? 0.5 : 0)) {
    const delay = FAULT_LATENCY_MS;
    logFault('LATENCY', { endpoint, delayMs: delay });
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // Error injection (5xx responses)
  if (FAULT_ERROR_RATE > 0 && Math.random() < FAULT_ERROR_RATE) {
    logFault('ERROR', { endpoint, rate: FAULT_ERROR_RATE });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', code: 500 }));
    return true; // Response already sent
  }

  // Timeout injection (no response)
  if (FAULT_TIMEOUT_RATE > 0 && Math.random() < FAULT_TIMEOUT_RATE) {
    logFault('TIMEOUT', { endpoint, rate: FAULT_TIMEOUT_RATE });
    // Don't send response - simulate timeout
    return true; // Response already "handled" (by not sending)
  }

  // Malformed response injection
  if (FAULT_MALFORMED_RATE > 0 && Math.random() < FAULT_MALFORMED_RATE) {
    logFault('MALFORMED', { endpoint, rate: FAULT_MALFORMED_RATE });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"invalid": json"'); // Malformed JSON
    return true; // Response already sent
  }

  return false; // No fault injected, proceed normally
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    const faultHandled = await applyFaults(req, res, 'health');
    if (!faultHandled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'mock-stellar' }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/accounts') {
    const faultHandled = await applyFaults(req, res, 'accounts');
    if (!faultHandled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _embedded: { records: [] } }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/account') {
    const faultHandled = await applyFaults(req, res, 'account');
    if (!faultHandled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account_id: 'GMOCK123', sequence: '1' }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/fee_stats') {
    const faultHandled = await applyFaults(req, res, 'fee_stats');
    if (!faultHandled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ fee_charged: 100, max_fee: 100000 }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/transactions') {
    const faultHandled = await applyFaults(req, res, 'transactions');
    if (!faultHandled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', hash: 'mock-hash' }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock-stellar listening on ${port}`);
  if (FAULT_INJECTION_ENABLED) {
    console.log(`Fault injection enabled: latency=${FAULT_LATENCY_MS}ms, error_rate=${FAULT_ERROR_RATE}, timeout_rate=${FAULT_TIMEOUT_RATE}, malformed_rate=${FAULT_MALFORMED_RATE}`);
  }
});
