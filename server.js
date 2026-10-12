require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const DEV_MODE = String(process.env.DEV_MODE || 'false').toLowerCase() === 'true';
const PAGE_SIZE = 48;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
    })
  : null;

const ALLOWED_CHANCES = new Set([80, 75, 50, 30, 10]);
// Диапазон цены целевого предмета (множитель к цене исходного) для каждого шанса.
const MULTIPLIERS = { 80: [1.0, 1.25], 75: [1.05, 1.4], 50: [1.25, 2.0], 30: [1.6, 3.2], 10: [2.5, 6.0] };

// Сети для пополнения. Когда подключишь платёжного провайдера — меняй только createDepositInvoice ниже.
const DEPOSIT_NETWORKS = [
  { id: 'usdt_trc20', label: 'USDT · TRC-20' },
  { id: 'usdt_ton', label: 'USDT · TON' },
  { id: 'ton', label: 'TON' },
  { id: 'btc', label: 'Bitcoin' },
  { id: 'eth', label: 'Ethereum' },
  { id: 'ltc', label: 'Litecoin' }
];
const MIN_DEPOSIT_CENTS = 10000; // 100 ₽

/* ---------- helpers ---------- */
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const likeEscape = s => s.replace(/[\\%_]/g, m => '\\' + m);
function intParam(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
function priceBand(sourcePriceCents, chance) {
  const [lo, hi] = MULTIPLIERS[chance];
  return { min: Math.round(Number(sourcePriceCents) * lo), max: Math.round(Number(sourcePriceCents) * hi) };
}

/* Зачисление на баланс. externalId делает платёж идемпотентным: повторный вызов с тем же id ничего не зачислит. */
async function creditBalance(client, userId, amountCents, kind, note, externalId = null) {
  const tx = await client.query(
    `INSERT INTO transactions(user_id,kind,amount_cents,note,external_id) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, kind, amountCents, note, externalId]
  );
  if (!tx.rowCount) return false; // уже зачислено
  await client.query('UPDATE users SET balance_cents = balance_cents + $2, updated_at = NOW() WHERE id = $1', [userId, amountCents]);
  return true;
}

/* ---------- Telegram auth ---------- */
function verifyTelegram(initData) {
  if (DEV_MODE && !initData) return { id: 'local-dev-user', username: 'Player' };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData) throw httpError(401, 'Нужна авторизация через Telegram');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw httpError(401, 'Неверные данные Telegram');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, 'Подпись Telegram не совпала');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) throw httpError(401, 'Сессия Telegram устарела, открой приложение заново');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw httpError(401, 'Пользователь Telegram не найден');
  return { id: String(user.id), username: String(user.username || user.first_name || 'Player').slice(0, 64) };
}
function auth(req, _res, next) {
  try {
    req.telegramUser = verifyTelegram(req.get('x-telegram-init-data') || '');
    next();
  } catch (e) {
    next(e.status ? e : httpError(401, 'Unauthorized'));
  }
}

/* ---------- routes ---------- */
app.get('/api/config', (_req, res) => res.json({ devMode: DEV_MODE, chanceOptions: [...ALLOWED_CHANCES], currency: 'RUB' }));

app.use('/api', (_req, res, next) => (pool ? next() : res.status(500).json({ error: 'DATABASE_URL не настроен в .env' })));
app.use('/api', auth);

// Профиль + баланс + инвентарь + последние операции.
app.get('/api/me', wrap(async (req, res) => {
  const data = await withTx(async client => {
    let user = (await client.query('SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE', [req.telegramUser.id])).rows[0];
    let isNew = false;
    if (!user) {
      isNew = true;
      user = (await client.query(
        `INSERT INTO users (telegram_id, username, balance_cents) VALUES ($1,$2,0)
         ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username RETURNING *`,
        [req.telegramUser.id, req.telegramUser.username]
      )).rows[0];
    } else {
      await client.query('UPDATE users SET username=$2, updated_at=NOW() WHERE id=$1', [user.id, req.telegramUser.username]);
    }
    const inventory = (await client.query(
      `SELECT i.id,i.name,i.weapon,i.skin,i.price_cents,i.image_url,i.rarity,inv.id AS inventory_id
       FROM inventory inv JOIN items i ON i.id=inv.item_id WHERE inv.user_id=$1 ORDER BY inv.acquired_at DESC, inv.id DESC`, [user.id])).rows;
    const popular = (await client.query(
      `SELECT id,name,weapon,skin,price_cents,image_url,rarity FROM items WHERE price_cents>0 ORDER BY price_cents DESC LIMIT 9`)).rows;
    const transactions = (await client.query(
      'SELECT kind,amount_cents,note,created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [user.id])).rows;
    return { user, isNew, inventory, popular, transactions };
  });
  const u = data.user;
  res.json({
    user: { username: u.username, telegramId: u.telegram_id, steamInventoryUrl: u.steam_inventory_url, balanceCents: Number(u.balance_cents), isNew: data.isNew },
    inventory: data.inventory,
    popular: data.popular,
    transactions: data.transactions
  });
}));

// Быстрый запрос только баланса.
app.get('/api/balance', wrap(async (req, res) => {
  const r = await pool.query('SELECT balance_cents FROM users WHERE telegram_id=$1', [req.telegramUser.id]);
  if (!r.rowCount) throw httpError(404, 'Пользователь не найден');
  res.json({ balanceCents: Number(r.rows[0].balance_cents) });
}));

async function searchItems({ q = '', min = 0, max = null, page = 0, excludeId = null, sort = 'asc' }) {
  const params = [];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  add('price_cents >= ?', min);
  if (max !== null) add('price_cents <= ?', max);
  if (q) add('name ILIKE ?', `%${likeEscape(q)}%`);
  if (excludeId) add('id <> ?', excludeId);
  params.push(PAGE_SIZE + 1, page * PAGE_SIZE);
  const sql = `SELECT id,name,weapon,skin,price_cents,image_url,rarity,market_url FROM items
    WHERE ${where.join(' AND ')} ORDER BY price_cents ${sort === 'desc' ? 'DESC' : 'ASC'}, id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return { items: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}
function readFilters(query) {
  const q = String(query.q || '').trim().slice(0, 80);
  const min = intParam(query.min, 0, 0, 2000000000);
  const max = query.max === undefined || query.max === '' ? null : intParam(query.max, null, 0, 2000000000);
  const page = intParam(query.page, 0, 0, 100000);
  return { q, min, max, page };
}

// Каталог магазина (с поиском и пагинацией).
app.get('/api/items', wrap(async (req, res) => {
  res.json(await searchItems({ ...readFilters(req.query), sort: req.query.sort === 'desc' ? 'desc' : 'asc' }));
}));

// Покупка предмета с баланса.
app.post('/api/shop/buy', wrap(async (req, res) => {
  const itemId = String(req.body.itemId || '');
  const out = await withTx(async client => {
    const u = (await client.query('SELECT id,balance_cents FROM users WHERE telegram_id=$1 FOR UPDATE', [req.telegramUser.id])).rows[0];
    if (!u) throw httpError(404, 'Пользователь не найден');
    const item = (await client.query('SELECT id,name,price_cents FROM items WHERE id=$1', [itemId])).rows[0];
    if (!item) throw httpError(404, 'Предмет не найден');
    if (Number(u.balance_cents) < item.price_cents) throw httpError(400, 'Недостаточно средств на балансе', 'INSUFFICIENT_FUNDS');
    const balance = (await client.query(
      'UPDATE users SET balance_cents=balance_cents-$2, updated_at=NOW() WHERE id=$1 RETURNING balance_cents', [u.id, item.price_cents])).rows[0].balance_cents;
    const inv = (await client.query('INSERT INTO inventory(user_id,item_id) VALUES($1,$2) RETURNING id', [u.id, item.id])).rows[0];
    await client.query('INSERT INTO transactions(user_id,kind,amount_cents,note) VALUES($1,$2,$3,$4)', [u.id, 'purchase', -item.price_cents, item.name]);
    return { inventoryId: inv.id, name: item.name, balanceCents: Number(balance) };
  });
  res.json(out);
}));

app.put('/api/profile', wrap(async (req, res) => {
  const url = String(req.body.steamInventoryUrl || '').trim();
  if (url && !/^https:\/\/steamcommunity\.com\/(id\/[A-Za-z0-9_-]+|profiles\/\d+)(\/inventory)?\/?$/.test(url)) {
    throw httpError(400, 'Введи корректную ссылку на публичный Steam-профиль или инвентарь.');
  }
  const r = await pool.query('UPDATE users SET steam_inventory_url=$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING steam_inventory_url', [req.telegramUser.id, url]);
  if (!r.rowCount) throw httpError(404, 'Пользователь не найден');
  res.json({ steamInventoryUrl: r.rows[0].steam_inventory_url });
}));

// Цели для апгрейда: цена попадает в диапазон выбранного шанса + поиск/фильтры/страницы.
app.get('/api/targets', wrap(async (req, res) => {
  const sourceId = String(req.query.sourceId || '');
  const chance = Number(req.query.chance);
  if (!ALLOWED_CHANCES.has(chance)) throw httpError(400, 'Неподдерживаемый шанс');
  if (!/^\d+$/.test(sourceId)) throw httpError(400, 'Неверный предмет');
  const r = await pool.query(
    `SELECT inv.id AS inventory_id, i.id,i.name,i.weapon,i.skin,i.price_cents,i.image_url,i.rarity
     FROM inventory inv JOIN users u ON u.id=inv.user_id JOIN items i ON i.id=inv.item_id
     WHERE u.telegram_id=$1 AND inv.id=$2`, [req.telegramUser.id, sourceId]);
  if (!r.rowCount) throw httpError(404, 'Этого предмета нет в твоём инвентаре');
  const source = r.rows[0];
  const band = priceBand(source.price_cents, chance);
  const f = readFilters(req.query);
  const found = await searchItems({
    q: f.q,
    min: Math.max(band.min, f.min),
    max: f.max === null ? band.max : Math.min(band.max, f.max),
    page: f.page,
    excludeId: source.id
  });
  res.json({ source, targets: found.items, hasMore: found.hasMore, priceBandCents: band });
}));

app.post('/api/upgrade', wrap(async (req, res) => {
  const sourceInventoryId = String(req.body.sourceInventoryId || '');
  const targetItemId = String(req.body.targetItemId || '');
  const chance = Number(req.body.chance);
  if (!ALLOWED_CHANCES.has(chance)) throw httpError(400, 'Неподдерживаемый шанс');
  if (!/^\d+$/.test(sourceInventoryId) || !targetItemId) throw httpError(400, 'Выбери предмет и цель');
  const out = await withTx(async client => {
    const u = (await client.query('SELECT id FROM users WHERE telegram_id=$1 FOR UPDATE', [req.telegramUser.id])).rows[0];
    if (!u) throw httpError(404, 'Пользователь не найден');
    const source = (await client.query(
      `SELECT inv.id AS inventory_id, i.id,i.name,i.price_cents FROM inventory inv
       JOIN items i ON i.id=inv.item_id WHERE inv.user_id=$1 AND inv.id=$2 FOR UPDATE OF inv`, [u.id, sourceInventoryId])).rows[0];
    if (!source) throw httpError(404, 'Этого предмета нет в твоём инвентаре');
    const target = (await client.query('SELECT id,name,price_cents,image_url FROM items WHERE id=$1', [targetItemId])).rows[0];
    if (!target) throw httpError(404, 'Целевой предмет не найден');
    if (target.id === source.id) throw httpError(400, 'Нельзя прокачать предмет в самого себя');
    const band = priceBand(source.price_cents, chance);
    if (target.price_cents < band.min || target.price_cents > band.max) throw httpError(400, 'Цена цели не подходит под выбранный шанс');
    // Честный бросок: шанс на экране = реальная вероятность (точность 0.01%).
    const success = crypto.randomInt(0, 10000) < chance * 100;
    await client.query('DELETE FROM inventory WHERE id=$1', [source.inventory_id]);
    if (success) await client.query('INSERT INTO inventory(user_id,item_id) VALUES($1,$2)', [u.id, target.id]);
    await client.query(
      'INSERT INTO upgrade_history(user_id,source_item_id,target_item_id,chance_percent,success) VALUES($1,$2,$3,$4,$5)',
      [u.id, source.id, target.id, chance, success]);
    return { success, chance, source: source.name, target: target.name };
  });
  res.json({ ...out, message: out.success ? 'Апгрейд удался!' : 'Апгрейд не удался. Предмет сгорел.' });
}));

/* ---------- Пополнение криптой ---------- */
app.get('/api/deposit-info', (_req, res) => res.json({ enabled: false, networks: DEPOSIT_NETWORKS, minAmountCents: MIN_DEPOSIT_CENTS }));

// TODO: подключить платёжного провайдера (NOWPayments, CryptoBot, Cryptomus и т.п.):
//  1) здесь создаёшь инвойс у провайдера и возвращаешь { payUrl } или { address, amount };
//  2) в вебхуке провайдера (подпись обязательно проверять!) вызываешь
//     creditBalance(client, userId, amountCents, 'deposit', 'Пополнение', invoiceId) — повторный вебхук ничего не зачислит.
async function createDepositInvoice(/* { user, network, amountCents } */) {
  throw httpError(501, 'Пополнение криптовалютой скоро будет доступно.', 'DEPOSIT_NOT_CONNECTED');
}
app.post('/api/deposit/create', wrap(async (req, res) => {
  const network = String(req.body.network || '');
  const amountCents = intParam(req.body.amountCents, 0, 0, 2000000000);
  if (!DEPOSIT_NETWORKS.some(n => n.id === network)) throw httpError(400, 'Выбери сеть для пополнения');
  if (amountCents < MIN_DEPOSIT_CENTS) throw httpError(400, 'Минимальная сумма пополнения — 100 ₽');
  res.json(await createDepositInvoice({ user: req.telegramUser, network, amountCents }));
}));

// Тестовое пополнение — работает ТОЛЬКО при DEV_MODE=true.
app.post('/api/dev/credit', wrap(async (req, res) => {
  if (!DEV_MODE) throw httpError(403, 'Недоступно');
  const amountCents = intParam(req.body.amountCents, 100000, 1, 100000000);
  const balance = await withTx(async client => {
    const u = (await client.query('SELECT id FROM users WHERE telegram_id=$1 FOR UPDATE', [req.telegramUser.id])).rows[0];
    if (!u) throw httpError(404, 'Пользователь не найден');
    await creditBalance(client, u.id, amountCents, 'dev_credit', 'Тестовое пополнение');
    return Number((await client.query('SELECT balance_cents FROM users WHERE id=$1', [u.id])).rows[0].balance_cents);
  });
  res.json({ balanceCents: balance });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message, code: err.code });
});

app.listen(PORT, () => console.log(`CRYPTO UPGRADE запущен: http://localhost:${PORT}`));
