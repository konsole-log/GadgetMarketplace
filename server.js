'use strict'

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, transcation } = require('./db')
const esewa = require('./payments/esewa')

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_ORDER_PAISA = 1000;

function why(err) {
  const c = err.cause;
  return c ? `${err.message} -> ${c.code || ''} ${c.message || c}`.trim() : err.message;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  // form-action must allow eSewa because the browser POSTs the payment form there.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://images.pexels.com; " +
    "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; " +
    "form-action 'self' https://*.esewa.com.np; frame-ancestors 'none'",
};

function sendJson(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readJson(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return reject(new HttpError(415, 'Expected application/json'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(403, 'Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}


const q = {
  listProducts: db.prepare('SELECT id, name, description, category, price, stock, image, image_focus FROM products ORDER BY id'),
  getProduct: db.prepare('SELECT id, name, description, category, price, stock, image, image_focus FROM products WHERE id = ?'),
  insertOrder: db.prepare(`INSERT INTO orders (public_id, customer_name, email, phone, address, total, gateway)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`),
  insertItem: db.prepare('INSERT INTO order_items (order_id, product_id, name, unit_price, qty) VALUES (?, ?, ?, ?, ?)'),
  setPaymentRef: db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?'),
  orderByPublicId: db.prepare('SELECT * FROM orders WHERE public_id = ?'),
  orderByRef: db.prepare('SELECT * FROM orders WHERE payment_ref = ?'),
  orderItems: db.prepare('SELECT product_id, name, unit_price, qty FROM order_items WHERE order_id = ?'),
  markPaid: db.prepare(`UPDATE orders SET status = 'paid', gateway_txn = ?, paid_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status = 'pending'`),
  markFailed: db.prepare(`UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'`),
  decrementStock: db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?'),
};


function markOrderPaid(order, gatewayTxn) {
  transaction(() => {
    const { changes } = q.markPaid.run(gatewayTxn ?? null, order.id);
    if (changes === 1) {
      for (const item of q.orderItems.all(order.id)) q.decrementStock.run(item.qty, item.product_id);
      console.log(`[order] ${order.public_id} PAID via ${order.gateway}(${gatewayTxn})`);
    }
  });
}

function validateCustomer(c = {}) {
  const name = String(c.name ?? '').trim();
  const email = String(c.email ?? '').trim().toLowerCase();
  const phone = String(c.phone ?? '').replace(/[\s-]/g, '');
  const address = String(c.address ?? '').trim();
  if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Please enter your full name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, 'Please enter a valid email');
  if (!/^9[678]\d{8}$/.test(phone)) throw new HttpError(400, 'Please enter a valid 10-digit mobile number');
  if (address.length < 5 || address.length > 300) throw new HttpError(400, 'Please enter your delivery address');
  return { name, email, phone, address };
}

async function verifyEsewa(order) {
  const result = await esewa.checkStatus({ transactionUuid: order.payment_ref, amountPaisa: order.total });
  if (result.status === "COMPLETE") {
    if (result.total_amount != null && esewa.rupeesToPaisa(result.total_amount) !== order.total) {
      throw new Error(`Amount mismatch on ${order.public_id}`);
    }
    markOrderPaid(order, result.ref_id);
  } else if (['NOT_FOUND', 'CANCELED'].includes(result.status)) {
    q.markFailed.run(order.id);
  }
}

function verifyOrder(order) {
  return verifyEsewa(order);
}

async function createOrder(req, res) {
  const body = await readJson(req);
  const gateway = 'esewa';
  const customer = validateCustomer(body.customer);
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, 'Your cart is empty');
  }
  const qtyById = new Map();
  for (const it of body.items.slice(0, 50)) {
    const id = Number(it.id), qty = Number(it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 10) {
      throw new HttpError(400, 'Invalid cart item');
    }
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }

  const lines = [];
  let total = 0;
  for (const [id, qty] of qtyById) {
    const p = q.getProduct.get(id);
    if (!p) throw new HttpError(400, 'A product in your cart no longer exists');
    if (p.stock < qty) throw new HttpError(409, `Only ${p.stock} left of "${p.name}"`);
    lines.push({ product: p, qty });
    total += p.price * qty;
  }
  if (total < MIN_ORDER_PAISA) throw new HttpError(400, 'Minimum order is Rs 10');

  const publicId = crypto.randomBytes(16).toString('hex');
  const orderId = transaction(() => {
    const { lastInsertRowid } = q.insertOrder.run(
      publicId, customer.name, customer.email, customer.phone, customer.address, total, gateway
    );
    for (const { product, qty } of lines) q.insertItem.run(lastInsertRowid, product.id, product.name, product.price, qty);
    return Number(lastInsertRowid);
  });

  try {
    const transactionUuid = `gs-${orderId}-${Date.now()}`;
    q.setPaymentRef.run(transactionUuid, orderId);
    const form = esewa.buildForm({
      amountPaisa: total,
      transactionUuid,
      successUrl: `${BASE_URL}/pay/esewa/success`,
      failureUrl: `${BASE_URL}/pay/esewa/failure/${publicId}`,
    });
    return sendJson(res, 201, { orderId: publicId, form });
  } catch (err) {
    q.markFailed.run(orderId);
    console.error('[payment] initiate failed:', why(err));
    throw new HttpError(502, 'Could not start the payment. Please try again.');
  }
}

async function esewaSuccess(res, params) {
  let payload;
  try { payload = esewa.verifyCallback(params.get('data')); }
  catch (err) { console.error('[esewa] callback:', why(err)); return redirect(res, '/order.html?error=invalid'); }
  const order = q.orderByRef.get(String(payload.transaction_uuid));
  if (!order) return redirect(res, '/order.html?error=unknown');
  try { await verifyEsewa(order); } catch (err) { console.error('[esewa] verify:', why(err)); }
  redirect(res, `/order.html?id=${order.public_id}`);
}

async function esewaFailure(res, publicId) {
  const order = q.orderByPublicId.get(publicId);
  if (!order) return redirect(res, '/order.html?error=unknown');
  try { await verifyEsewa(order); } catch (err) { console.error('[esewa] verify:', why(err)); }
  redirect(res, `/order.html?id=${order.public_id}`);
}

async function getOrder(res, publicId) {
  let order = q.orderByPublicId.get(publicId);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === 'pending' && order.payment_ref) {
    try { await verifyOrder(order); } catch (err) { console.error('[verify]', why(err)); }
    order = q.orderByPublicId.get(publicId);
  }
  sendJson(res, 200, {
    id: order.public_id, status: order.status, gateway: order.gateway, total: order.total,
    customerName: order.customer_name, createdAt: order.created_at, paidAt: order.paid_at,
    items: q.orderItems.all(order.id),
  });
}

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const { pathname, searchParams } = url;
  const method = req.method;
  let m;

  if (method === 'GET' && pathname === '/api/products') return sendJson(res, 200, q.listProducts.all());
  if (method === 'GET' && (m = pathname.match(/^\/api\/products\/(\d+)$/))) {
    const p = q.getProduct.get(Number(m[1]));
    return p ? sendJson(res, 200, p) : sendJson(res, 404, { error: 'Product not found' });
  }
  if (method === 'POST' && pathname === '/api/orders') return createOrder(req, res);
  if (method === 'GET' && (m = pathname.match(/^\/api\/orders\/([a-f0-9]{32})$/))) return getOrder(res, m[1]);

  if (method === 'GET' && pathname === '/pay/esewa/success') return esewaSuccess(res, searchParams);
  if (method === 'GET' && (m = pathname.match(/^\/pay\/esewa\/failure\/([a-f0-9]{32})$/))) return esewaFailure(res, m[1]);

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
  if (method === 'GET' || method === 'HEAD') {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Bad URL'); }
    return serveStatic(req, res, decoded);
  }
  throw new HttpError(405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
  });
});

server.listen(PORT, () => {
  console.log(`Jhilko is running at ${BASE_URL}`);
  console.log(`eSewa: ${process.env.ESEWA_ENV === 'live' ? 'LIVE' : 'test mode'}`);
});
