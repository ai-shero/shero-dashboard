/**
 * fetch wrapper that uses Node's https module so SSL_INSECURE=true works.
 * On Render (production), SSL_INSECURE is not set, so it behaves normally.
 */
const https = require('https');
const http  = require('http');

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function apiFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = (isHttps && process.env.SSL_INSECURE === 'true') ? insecureAgent : undefined;

    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
      agent
    };

    const req = lib.request(reqOptions, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok:     resp.statusCode >= 200 && resp.statusCode < 300,
          status: resp.statusCode,
          headers: { get: (h) => resp.headers[h.toLowerCase()] ?? null },
          json:   () => Promise.resolve(JSON.parse(body)),
          text:   () => Promise.resolve(body),
        });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(
      typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    );
    req.end();
  });
}

module.exports = { apiFetch };
