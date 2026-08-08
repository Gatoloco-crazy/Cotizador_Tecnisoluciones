const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = __dirname;

// Cargar variables de entorno
(function loadEnvironment() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const separator = value.indexOf('=');
    if (separator < 1) continue;
    const key = value.slice(0, separator).trim();
    const raw = value.slice(separator + 1).trim();
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
})();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const FALLBACK_FILE = path.join(DATA_DIR, 'local-data.json');
const USUARIOS_JSON_PATH = path.join(ROOT, 'database', 'usuarios.json');
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'TECNISOLUCIONES_BS',
};

// ============================================
// SISTEMA DE AUTENTICACIÓN Y SEGURIDAD
// ============================================

// Mapa de sesiones en memoria: { session_id: { usuario, expiraEn } }
const sesionesActivas = new Map();

// Duración de sesión en milisegundos (24 horas)
const SESION_DURACION_MS = 24 * 60 * 60 * 1000;

/**
 * Carga usuarios desde archivo JSON local
 * @returns {Array} Lista de usuarios
 */
function cargarUsuariosJSON() {
  try {
    if (!fs.existsSync(USUARIOS_JSON_PATH)) {
      // Crear archivo si no existe
      const dbDir = path.dirname(USUARIOS_JSON_PATH);
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
      fs.writeFileSync(USUARIOS_JSON_PATH, JSON.stringify({ usuarios: [] }, null, 2));
      return [];
    }
    const data = JSON.parse(fs.readFileSync(USUARIOS_JSON_PATH, 'utf8'));
    return data.usuarios || [];
  } catch {
    return [];
  }
}

/**
 * Guarda usuarios en archivo JSON local
 * @param {Array} usuarios - Lista de usuarios a guardar
 */
function guardarUsuariosJSON(usuarios) {
  const dbDir = path.dirname(USUARIOS_JSON_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(USUARIOS_JSON_PATH, JSON.stringify({ usuarios }, null, 2));
}

/**
 * Busca un usuario por correo en MySQL o JSON
 * @param {string} correo - Correo del usuario
 * @returns {Promise<Object|null>} Usuario encontrado o null
 */
async function buscarUsuarioPorCorreo(correo) {
  if (pool && databaseMode === 'mysql') {
    try {
      const [rows] = await pool.query('SELECT id, correo, password_hash, creado_en FROM usuarios WHERE correo = ?', [correo]);
      if (rows.length > 0) return rows[0];
    } catch {
      // Si falla MySQL, intentar con JSON
    }
  }
  // Fallback a JSON
  const usuarios = cargarUsuariosJSON();
  return usuarios.find(u => u.correo.toLowerCase() === correo.toLowerCase()) || null;
}

/**
 * Crea un nuevo usuario administrador
 * @param {string} correo - Correo del usuario
 * @param {string} password - Contraseña en texto plano
 * @returns {Promise<Object>} Usuario creado
 * @throws {Error} Si el usuario ya existe o hay error
 */
async function crearUsuarioAdmin(correo, password) {
  // Verificar si ya existe
  const existente = await buscarUsuarioPorCorreo(correo);
  if (existente) {
    throw new Error('Ya existe un usuario con ese correo.');
  }

  // Generar hash con bcrypt (salt 10)
  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  if (pool && databaseMode === 'mysql') {
    try {
      // Asegurar que la tabla existe
      await pool.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          correo VARCHAR(120) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_usuarios_correo (correo)
        ) ENGINE=InnoDB;
      `);
      
      const [result] = await pool.execute(
        'INSERT INTO usuarios (correo, password_hash) VALUES (?, ?)',
        [correo, passwordHash]
      );
      
      return { id: result.insertId, correo, creado_en: new Date().toISOString() };
    } catch (error) {
      // Si falla MySQL, usar JSON
    }
  }

  // Guardar en JSON
  const usuarios = cargarUsuariosJSON();
  const nuevoUsuario = {
    id: usuarios.length > 0 ? Math.max(...usuarios.map(u => u.id)) + 1 : 1,
    correo,
    password_hash: passwordHash,
    creado_en: new Date().toISOString(),
  };
  usuarios.push(nuevoUsuario);
  guardarUsuariosJSON(usuarios);
  return nuevoUsuario;
}

/**
 * Valida las credenciales de un usuario
 * @param {string} correo - Correo del usuario
 * @param {string} password - Contraseña en texto plano
 * @returns {Promise<Object|null>} Usuario si es válido, null si no
 */
async function validarCredenciales(correo, password) {
  const usuario = await buscarUsuarioPorCorreo(correo);
  if (!usuario) return null;

  const passwordValido = await bcrypt.compare(password, usuario.password_hash);
  if (!passwordValido) return null;

  return usuario;
}

/**
 * Genera un token de sesión único
 * @returns {string} Token de sesión
 */
function generarTokenSesion() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Crea una nueva sesión para un usuario
 * @param {string} token - Token de sesión
 * @param {Object} usuario - Datos del usuario
 * @returns {Object} Información de la sesión
 */
function crearSesion(token, usuario) {
  const expiraEn = Date.now() + SESION_DURACION_MS;
  const sesion = {
    usuario: { id: usuario.id, correo: usuario.correo },
    expiraEn,
  };
  sesionesActivas.set(token, sesion);
  return sesion;
}

/**
 * Limpia sesiones expiradas del mapa
 */
function limpiarSesionesExpiradas() {
  const ahora = Date.now();
  for (const [token, sesion] of sesionesActivas.entries()) {
    if (sesion.expiraEn < ahora) {
      sesionesActivas.delete(token);
    }
  }
}

// Limpiar sesiones expiradas cada hora
setInterval(limpiarSesionesExpiradas, 60 * 60 * 1000);

/**
 * Extrae el session_id de las cookies de la petición
 * @param {Object} req - Petición HTTP
 * @returns {string|null} Session ID o null si no existe
 */
function obtenerSessionIdDeCookies(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith('session_id=')) {
      return cookie.slice('session_id='.length);
    }
  }
  return null;
}

/**
 * Middleware para verificar si el usuario está autenticado como admin
 * @param {Object} req - Petición HTTP
 * @returns {Object|null} Información de la sesión si es válida, null si no
 */
function esAdminAutenticado(req) {
  const sessionId = obtenerSessionIdDeCookies(req);
  if (!sessionId) return null;

  const sesion = sesionesActivas.get(sessionId);
  if (!sesion) return null;

  // Verificar expiración
  if (sesion.expiraEn < Date.now()) {
    sesionesActivas.delete(sessionId);
    return null;
  }

  return sesion;
}

/**
 * Parsea el cuerpo de una petición JSON
 */

let mysql;
let pool;
let databaseMode = 'local';

async function initializeDatabase() {
  try {
    mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
      database: DB_CONFIG.database, 
      multipleStatements: true
    });
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.end();

    pool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
      multipleStatements: true,
    });
    await createTables();
    await seedProducts();
    databaseMode = 'mysql';
    console.log(`MySQL conectado: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  } catch (error) {
    pool = null;
    databaseMode = 'local';
    ensureFallbackData();
    console.warn(`MySQL no disponible; se usará modo local. ${error.message}`);
  }
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      nombre VARCHAR(180) NOT NULL,
      telefono VARCHAR(20) NULL,
      correo VARCHAR(120) NULL,
      direccion TEXT NULL,
      creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_clientes_nombre (nombre)
    ) ENGINE=InnoDB;
    CREATE TABLE IF NOT EXISTS productos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      codigo VARCHAR(50) NOT NULL,
      nombre VARCHAR(180) NOT NULL,
      descripcion TEXT NULL,
      precio DECIMAL(10,2) NOT NULL,
      creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_productos_codigo (codigo), KEY idx_productos_nombre (nombre)
    ) ENGINE=InnoDB;
    CREATE TABLE IF NOT EXISTS cotizaciones (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      codigo_cotizacion VARCHAR(30) NOT NULL,
      cliente_id BIGINT UNSIGNED NOT NULL,
      fecha_cotizacion DATE NOT NULL,
      estado VARCHAR(50) NOT NULL DEFAULT 'Borrador',
      notas TEXT NULL,
      total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_cotizaciones_codigo (codigo_cotizacion), KEY idx_cotizaciones_cliente (cliente_id),
      CONSTRAINT fk_cotizaciones_cliente FOREIGN KEY (cliente_id) REFERENCES clientes (id) ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB;
    CREATE TABLE IF NOT EXISTS detalle_cotizacion (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      cotizacion_id BIGINT UNSIGNED NOT NULL,
      producto_id BIGINT UNSIGNED NOT NULL,
      cantidad INT NOT NULL,
      precio_unitario DECIMAL(10,2) NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      PRIMARY KEY (id), KEY idx_detalle_cotizacion (cotizacion_id), KEY idx_detalle_producto (producto_id),
      CONSTRAINT fk_detalle_cotizacion FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones (id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT fk_detalle_producto FOREIGN KEY (producto_id) REFERENCES productos (id) ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB;
  `);
}

function defaultProducts() {
  return [
    ['CAM-DAH-2MP', 'Cámara Dahua 2MP', 'Cámara HD con visión nocturna y protección IP67.', 350],
    ['CAM-HIK-4MP', 'Cámara Hikvision 4MP', 'Cámara IP con detección inteligente y compresión H.265+.', 375],
    ['DVR-8CH', 'DVR 8 canales', 'Grabador digital con acceso remoto y soporte para disco duro.', 850],
    ['NVR-4POE', 'NVR 4 canales PoE', 'Grabador IP con PoE integrado y resolución de hasta 8 MP.', 950],
    ['BAL-UTP', 'Video balun (par)', 'Transmisor y receptor de video por cable UTP Cat5e.', 45],
    ['INS-CCTV', 'Servicio de instalación', 'Instalación, canaleta, fijaciones y configuración del sistema.', 600],
  ];
}

async function seedProducts() {
  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM productos');
  if (Number(rows[0].total) > 0) return;
  for (const product of defaultProducts()) {
    await pool.execute('INSERT INTO productos (codigo, nombre, descripcion, precio) VALUES (?, ?, ?, ?)', product);
  }
}

function ensureFallbackData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FALLBACK_FILE)) return;
  const now = new Date().toISOString();
  const products = defaultProducts().map(([codigo, nombre, descripcion, precio], index) => ({
    id: index + 1, codigo, nombre, descripcion, precio, creado_en: now, actualizado_en: now,
  }));
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify({ clients: [], products, quotes: [] }, null, 2));
}

function localData() {
  ensureFallbackData();
  return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
}

function saveLocalData(data) {
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(data, null, 2));
}

function sendJson(response, status, data, headers = {}) {
  const allHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  response.writeHead(status, allHeaders);
  response.end(JSON.stringify(data));
}

function sendError(response, status, message) {
  sendJson(response, status, { message });
}

/**
 * Maneja el endpoint de login POST /api/login
 */
async function handleLogin(request, response) {
  try {
    const body = await readBody(request);
    const { username, password } = body;

    if (!username || !password) {
      return sendError(response, 400, 'Debes proporcionar usuario (correo) y contraseña.');
    }

    // Validar credenciales
    const usuario = await validarCredenciales(username, password);
    if (!usuario) {
      return sendError(response, 401, 'Usuario o contraseña incorrectos.');
    }

    // Generar token de sesión
    const token = generarTokenSesion();
    crearSesion(token, usuario);

    // Establecer cookie HttpOnly
    const cookieOptions = [
      `session_id=${token}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESION_DURACION_MS / 1000)}`,
    ];

    return sendJson(response, 200, {
      ok: true,
      mensaje: 'Inicio de sesión exitoso.',
      usuario: { id: usuario.id, correo: usuario.correo },
    }, { 'Set-Cookie': cookieOptions.join('; ') });
  } catch (error) {
    return sendError(response, 500, error.message || 'Error al iniciar sesión.');
  }
}

/**
 * Maneja el endpoint para crear admin POST /api/crear-admin
 * Requiere autenticación previa
 */
async function handleCrearAdmin(request, response) {
  try {
    // Verificar autenticación
    const sesion = esAdminAutenticado(request);
    if (!sesion) {
      return sendError(response, 403, 'No autorizado. Debes iniciar sesión como administrador.');
    }

    const body = await readBody(request);
    const { username, password } = body;

    if (!username || !password) {
      return sendError(response, 400, 'Debes proporcionar correo y contraseña para el nuevo administrador.');
    }

    // Validar formato de correo
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      return sendError(response, 400, 'El correo no es válido.');
    }

    // Validar longitud de contraseña
    if (password.length < 6) {
      return sendError(response, 400, 'La contraseña debe tener al menos 6 caracteres.');
    }

    // Crear usuario administrador
    const nuevoUsuario = await crearUsuarioAdmin(username, password);

    return sendJson(response, 201, {
      ok: true,
      mensaje: 'Administrador creado exitosamente.',
      usuario: { id: nuevoUsuario.id, correo: nuevoUsuario.correo },
    });
  } catch (error) {
    return sendError(response, error.message === 'Ya existe un usuario con ese correo.' ? 409 : 400, error.message);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('El cuerpo de la solicitud no es JSON válido.')); }
    });
  });
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value, maxLength = 65535) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function dateOnly(value) {
  const source = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : new Date().toISOString().slice(0, 10);
}

function formatProduct(product) {
  return { ...product, precio: Number(product.precio) };
}

function formatClient(client) {
  return { ...client, telefono: client.telefono || '', correo: client.correo || '', direccion: client.direccion || '' };
}

async function listProducts() {
  if (!pool) return localData().products.map(formatProduct).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const [rows] = await pool.query('SELECT id, codigo, nombre, descripcion, precio, creado_en, actualizado_en FROM productos ORDER BY nombre');
  return rows.map(formatProduct);
}

async function createProduct(body) {
  const nombre = text(body.nombre, 180);
  const descripcion = text(body.descripcion);
  const precio = Number(body.precio);
  const codigo = text(body.codigo, 50) || `PRD-${Date.now().toString().slice(-8)}`;
  if (!nombre || !Number.isFinite(precio) || precio <= 0) throw new Error('Indica nombre y precio válido para el producto.');
  if (!pool) {
    const data = localData();
    if (data.products.some((item) => item.codigo.toLowerCase() === codigo.toLowerCase())) throw new Error('El código de producto ya existe.');
    const item = { id: nextId(data.products), codigo, nombre, descripcion, precio, creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString() };
    data.products.push(item); saveLocalData(data); return formatProduct(item);
  }
  const [result] = await pool.execute('INSERT INTO productos (codigo, nombre, descripcion, precio) VALUES (?, ?, ?, ?)', [codigo, nombre, descripcion || null, precio]);
  const [rows] = await pool.execute('SELECT id, codigo, nombre, descripcion, precio, creado_en, actualizado_en FROM productos WHERE id = ?', [result.insertId]);
  return formatProduct(rows[0]);
}

async function deleteProduct(id) {
  if (!pool) {
    const data = localData();
    if (data.quotes.some((quote) => quote.items.some((item) => item.producto_id === id))) throw new Error('No se puede eliminar: el producto ya pertenece a una cotización.');
    data.products = data.products.filter((item) => item.id !== id); saveLocalData(data); return;
  }
  const [result] = await pool.execute('DELETE FROM productos WHERE id = ?', [id]);
  if (!result.affectedRows) throw new Error('Producto no encontrado.');
}

async function listClients() {
  if (!pool) return localData().clients.map(formatClient).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const [rows] = await pool.query('SELECT id, nombre, telefono, correo, direccion, creado_en, actualizado_en FROM clientes ORDER BY nombre');
  return rows.map(formatClient);
}

function validateClient(body) {
  const client = { nombre: text(body.nombre, 180), telefono: text(body.telefono, 20), correo: text(body.correo, 120), direccion: text(body.direccion) };
  if (!client.nombre) throw new Error('El nombre del cliente es obligatorio.');
  if (client.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.correo)) throw new Error('El correo del cliente no es válido.');
  return client;
}

async function createClient(body) {
  const client = validateClient(body);
  if (!pool) {
    const data = localData(); const now = new Date().toISOString();
    const saved = { id: nextId(data.clients), ...client, creado_en: now, actualizado_en: now };
    data.clients.push(saved); saveLocalData(data); return formatClient(saved);
  }
  const [result] = await pool.execute('INSERT INTO clientes (nombre, telefono, correo, direccion) VALUES (?, ?, ?, ?)', [client.nombre, client.telefono || null, client.correo || null, client.direccion || null]);
  const [rows] = await pool.execute('SELECT id, nombre, telefono, correo, direccion, creado_en, actualizado_en FROM clientes WHERE id = ?', [result.insertId]);
  return formatClient(rows[0]);
}

async function updateClient(id, body) {
  const client = validateClient(body);
  if (!pool) {
    const data = localData(); const index = data.clients.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('Cliente no encontrado.');
    data.clients[index] = { ...data.clients[index], ...client, actualizado_en: new Date().toISOString() }; saveLocalData(data); return formatClient(data.clients[index]);
  }
  const [result] = await pool.execute('UPDATE clientes SET nombre = ?, telefono = ?, correo = ?, direccion = ? WHERE id = ?', [client.nombre, client.telefono || null, client.correo || null, client.direccion || null, id]);
  if (!result.affectedRows) throw new Error('Cliente no encontrado.');
  const [rows] = await pool.execute('SELECT id, nombre, telefono, correo, direccion, creado_en, actualizado_en FROM clientes WHERE id = ?', [id]);
  return formatClient(rows[0]);
}

async function deleteClient(id) {
  if (!pool) {
    const data = localData();
    if (data.quotes.some((quote) => quote.cliente_id === id)) throw new Error('No se puede eliminar: el cliente tiene cotizaciones asociadas.');
    data.clients = data.clients.filter((item) => item.id !== id); saveLocalData(data); return;
  }
  const [result] = await pool.execute('DELETE FROM clientes WHERE id = ?', [id]);
  if (!result.affectedRows) throw new Error('Cliente no encontrado.');
}

function formatQuote(row, details = []) {
  return {
    id: row.id,
    codigoCotizacion: row.codigo_cotizacion,
    clienteId: row.cliente_id,
    clienteNombre: row.cliente_nombre || row.clienteNombre,
    clienteTelefono: row.cliente_telefono || row.clienteTelefono || '',
    fechaCotizacion: row.fecha_cotizacion,
    estado: row.estado,
    notas: row.notas || '',
    total: Number(row.total),
    creadoEn: row.creado_en || row.creadoEn,
    items: details.map((item) => ({ productoId: item.producto_id, codigo: item.codigo, nombre: item.nombre, cantidad: Number(item.cantidad), precioUnitario: Number(item.precio_unitario), subtotal: Number(item.subtotal) })),
  };
}

async function listQuotes() {
  if (!pool) {
    const data = localData();
    return data.quotes.sort((a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn))).map((quote) => formatQuote(quote, quote.items));
  }
  const [quotes] = await pool.query(`SELECT c.id, c.codigo_cotizacion, c.cliente_id, cl.nombre AS cliente_nombre, cl.telefono AS cliente_telefono, c.fecha_cotizacion, c.estado, c.notas, c.total, c.creado_en FROM cotizaciones c INNER JOIN clientes cl ON cl.id = c.cliente_id ORDER BY c.creado_en DESC, c.id DESC`);
  if (!quotes.length) return [];
  const ids = quotes.map((quote) => quote.id);
  const [details] = await pool.query(`SELECT d.cotizacion_id, d.producto_id, p.codigo, p.nombre, d.cantidad, d.precio_unitario, d.subtotal FROM detalle_cotizacion d INNER JOIN productos p ON p.id = d.producto_id WHERE d.cotizacion_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.id`, ids);
  return quotes.map((quote) => formatQuote(quote, details.filter((detail) => detail.cotizacion_id === quote.id)));
}

async function getQuote(id) {
  return (await listQuotes()).find((quote) => quote.id === id) || null;
}

function validateQuote(body) {
  const clienteId = integer(body.clienteId);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!clienteId) throw new Error('Selecciona un cliente.');
  if (!items.length) throw new Error('Agrega al menos un producto a la cotización.');
  const normalized = items.map((item) => ({ productoId: integer(item.productoId), cantidad: integer(item.cantidad) })).filter((item) => item.productoId && item.cantidad);
  if (normalized.length !== items.length) throw new Error('Hay un producto o una cantidad inválida.');
  return { clienteId, fechaCotizacion: dateOnly(body.fechaCotizacion), estado: text(body.estado, 50) || 'Borrador', notas: text(body.notas), items: normalized };
}

function makeQuoteCode() {
  return `COT-${new Date().getFullYear()}-${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`;
}

async function createQuote(body) {
  const input = validateQuote(body);
  if (!pool) return createLocalQuote(input);
  const connection = await pool.getConnection();
  try {
    const [clients] = await connection.execute('SELECT id, nombre, telefono FROM clientes WHERE id = ?', [input.clienteId]);
    if (!clients.length) throw new Error('El cliente seleccionado ya no existe.');
    const productIds = [...new Set(input.items.map((item) => item.productoId))];
    const [products] = await connection.query(`SELECT id, codigo, nombre, precio FROM productos WHERE id IN (${productIds.map(() => '?').join(',')})`, productIds);
    if (products.length !== productIds.length) throw new Error('Uno de los productos ya no existe. Actualiza el catálogo.');
    const productMap = new Map(products.map((product) => [product.id, product]));
    const details = input.items.map((item) => {
      const product = productMap.get(item.productoId);
      const precioUnitario = Number(product.precio); const subtotal = precioUnitario * item.cantidad;
      return { ...item, ...product, precioUnitario, subtotal };
    });
    const total = details.reduce((sum, item) => sum + item.subtotal, 0);
    await connection.beginTransaction();
    const codigo = makeQuoteCode();
    const [result] = await connection.execute('INSERT INTO cotizaciones (codigo_cotizacion, cliente_id, fecha_cotizacion, estado, notas, total) VALUES (?, ?, ?, ?, ?, ?)', [codigo, input.clienteId, input.fechaCotizacion, input.estado, input.notas || null, total]);
    for (const item of details) await connection.execute('INSERT INTO detalle_cotizacion (cotizacion_id, producto_id, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)', [result.insertId, item.id, item.cantidad, item.precioUnitario, item.subtotal]);
    await connection.commit();
    return { id: result.insertId, codigoCotizacion: codigo, clienteId: input.clienteId, clienteNombre: clients[0].nombre, clienteTelefono: clients[0].telefono || '', fechaCotizacion: input.fechaCotizacion, estado: input.estado, notas: input.notas, total, creadoEn: new Date().toISOString(), items: details.map(({ id, codigo: productCode, nombre, cantidad, precioUnitario, subtotal }) => ({ productoId: id, codigo: productCode, nombre, cantidad, precioUnitario, subtotal })) };
  } catch (error) {
    await connection.rollback(); throw error;
  } finally { connection.release(); }
}

function createLocalQuote(input) {
  const data = localData();
  const client = data.clients.find((item) => item.id === input.clienteId);
  if (!client) throw new Error('El cliente seleccionado ya no existe.');
  const details = input.items.map((item) => {
    const product = data.products.find((entry) => entry.id === item.productoId);
    if (!product) throw new Error('Uno de los productos ya no existe. Actualiza el catálogo.');
    const precioUnitario = Number(product.precio); return { producto_id: product.id, codigo: product.codigo, nombre: product.nombre, cantidad: item.cantidad, precio_unitario: precioUnitario, subtotal: precioUnitario * item.cantidad };
  });
  const total = details.reduce((sum, item) => sum + item.subtotal, 0); const now = new Date().toISOString();
  const row = { id: nextId(data.quotes), codigo_cotizacion: makeQuoteCode(), cliente_id: client.id, clienteNombre: client.nombre, clienteTelefono: client.telefono, fecha_cotizacion: input.fechaCotizacion, estado: input.estado, notas: input.notas, total, creadoEn: now, items: details };
  data.quotes.push(row); saveLocalData(data); return formatQuote(row, row.items);
}

async function deleteQuote(id) {
  if (!pool) { const data = localData(); data.quotes = data.quotes.filter((item) => item.id !== id); saveLocalData(data); return; }
  const [result] = await pool.execute('DELETE FROM cotizaciones WHERE id = ?', [id]);
  if (!result.affectedRows) throw new Error('Cotización no encontrada.');
}

function nextId(items) { return Math.max(0, ...items.map((item) => Number(item.id) || 0)) + 1; }

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const segments = url.pathname.split('/').filter(Boolean);
  try {
    // Endpoint de salud (público)
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, { mode: databaseMode, database: DB_CONFIG.database });
    }
    
    // Endpoint de login (público)
    if (segments[0] === 'api' && segments[1] === 'login' && request.method === 'POST') {
      return await handleLogin(request, response);
    }
    
    // Endpoint para crear admin (protegido)
    if (segments[0] === 'api' && segments[1] === 'crear-admin' && request.method === 'POST') {
      return await handleCrearAdmin(request, response);
    }
    
    // Rutas de API protegidas para métodos de modificación
    if (segments[0] === 'api' && segments[1] === 'productos') {
      // POST requiere autenticación
      if (request.method === 'POST' && !id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        return sendJson(response, 201, await createProduct(await readBody(request)));
      }
      // DELETE requiere autenticación
      if (request.method === 'DELETE' && id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        await deleteProduct(id);
        return sendJson(response, 200, { ok: true });
      }
      // GET es público
      if (request.method === 'GET' && !id) {
        return sendJson(response, 200, await listProducts());
      }
      return sendError(response, 405, 'Método no permitido.');
    }
    
    if (segments[0] === 'api' && segments[1] === 'clientes') {
      // POST y PUT requieren autenticación
      if (request.method === 'POST' && !id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        return sendJson(response, 201, await createClient(await readBody(request)));
      }
      if (request.method === 'PUT' && id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        return sendJson(response, 200, await updateClient(id, await readBody(request)));
      }
      // DELETE requiere autenticación
      if (request.method === 'DELETE' && id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        await deleteClient(id);
        return sendJson(response, 200, { ok: true });
      }
      // GET es público
      if (request.method === 'GET' && !id) {
        return sendJson(response, 200, await listClients());
      }
      return sendError(response, 405, 'Método no permitido.');
    }
    
    if (segments[0] === 'api' && segments[1] === 'cotizaciones') {
      // POST requiere autenticación
      if (request.method === 'POST' && !id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        return sendJson(response, 201, await createQuote(await readBody(request)));
      }
      // DELETE requiere autenticación
      if (request.method === 'DELETE' && id) {
        if (!esAdminAutenticado(request)) {
          return sendError(response, 403, 'No autorizado. Debes iniciar sesión.');
        }
        await deleteQuote(id);
        return sendJson(response, 200, { ok: true });
      }
      // GET es público
      if (request.method === 'GET' && !id) return sendJson(response, 200, await listQuotes());
      if (request.method === 'GET' && id) {
        const quote = await getQuote(id);
        return quote ? sendJson(response, 200, quote) : sendError(response, 404, 'Cotización no encontrada.');
      }
      return sendError(response, 405, 'Método no permitido.');
    }
    
    if (segments[0] === 'api') return sendError(response, 404, 'Ruta de API no encontrada.');
    return serveStatic(url.pathname, response);
  } catch (error) {
    const duplicate = error && error.code === 'ER_DUP_ENTRY';
    const relation = error && (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451);
    return sendError(response, duplicate ? 409 : relation ? 409 : 400, duplicate ? 'Ya existe un registro con ese código.' : relation ? 'No se puede eliminar porque tiene registros relacionados.' : error.message || 'No se pudo procesar la solicitud.');
  }
}

async function routeProducts(request, response, id) {
  if (request.method === 'GET' && !id) return sendJson(response, 200, await listProducts());
  if (request.method === 'POST' && !id) return sendJson(response, 201, await createProduct(await readBody(request)));
  if (request.method === 'DELETE' && id) { await deleteProduct(id); return sendJson(response, 200, { ok: true }); }
  return sendError(response, 405, 'Método no permitido.');
}

async function routeClients(request, response, id) {
  if (request.method === 'GET' && !id) return sendJson(response, 200, await listClients());
  if (request.method === 'POST' && !id) return sendJson(response, 201, await createClient(await readBody(request)));
  if (request.method === 'PUT' && id) return sendJson(response, 200, await updateClient(id, await readBody(request)));
  if (request.method === 'DELETE' && id) { await deleteClient(id); return sendJson(response, 200, { ok: true }); }
  return sendError(response, 405, 'Método no permitido.');
}

async function routeQuotes(request, response, id) {
  if (request.method === 'GET' && !id) return sendJson(response, 200, await listQuotes());
  if (request.method === 'GET' && id) { const quote = await getQuote(id); return quote ? sendJson(response, 200, quote) : sendError(response, 404, 'Cotización no encontrada.'); }
  if (request.method === 'POST' && !id) return sendJson(response, 201, await createQuote(await readBody(request)));
  if (request.method === 'DELETE' && id) { await deleteQuote(id); return sendJson(response, 200, { ok: true }); }
  return sendError(response, 405, 'Método no permitido.');
}

function serveStatic(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) return sendError(response, 403, 'Acceso denegado.');
  fs.readFile(filePath, (error, content) => {
    if (error) return sendError(response, 404, 'Página no encontrada.');
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(filePath)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type }); response.end(content);
  });
}

initializeDatabase().then(() => http.createServer(route).listen(PORT, () => console.log(`Cotizador disponible en http://localhost:${PORT}`)));
