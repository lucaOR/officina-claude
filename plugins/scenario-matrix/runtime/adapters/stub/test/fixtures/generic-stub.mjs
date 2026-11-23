// A small stand-in stub server for the process tests. It speaks the control plane the stub adapter
// expects: GET and DELETE /__scn/requests for the journal, POST and DELETE /__scn/fail for faults.
// Every other request is journaled and answered 200, or with the injected status while a fault
// matches its path. Prints one line once it listens, which is what bootStub waits for.
import http from 'node:http';

const journal = [];
let faults = [];

const readBody = req => new Promise(resolve => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => resolve(body));
});

const send = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload === undefined ? '' : JSON.stringify(payload));
};

http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__scn/requests') {
    if (req.method === 'DELETE') { journal.length = 0; return send(res, 204); }
    return send(res, 200, journal);
  }
  if (path === '/__scn/fail') {
    if (req.method === 'DELETE') { faults = []; return send(res, 204); }
    let spec;
    try { spec = JSON.parse(await readBody(req)); } catch { spec = null; }
    if (typeof spec?.path !== 'string') return send(res, 400, { error: 'fault spec requires a string "path"' });
    faults.push({ path: spec.path, status: spec.status ?? 500, left: spec.times ?? Infinity });
    return send(res, 204);
  }
  journal.push({ method: req.method, path: req.url, body: await readBody(req), at: new Date().toISOString() });
  const fault = faults.find(f => f.path === path && f.left > 0);
  if (fault) {
    fault.left -= 1;
    return send(res, fault.status, { message: 'injected fault' });
  }
  return send(res, 200, {});
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log(`generic stub listening on ${process.env.PORT}`));
