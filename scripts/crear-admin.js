/**
 * Script para crear un usuario administrador
 * Uso: npm run crear-admin -- correo@ejemplo.com contraseña123
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Configuración de entorno y base de datos
const ROOT = __dirname;
const envPath = path.join(ROOT, '.env');

function loadEnvironment() {
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
}

loadEnvironment();

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'TECNISOLUCIONES_BS',
};

const USUARIOS_JSON_PATH = path.join(ROOT, 'database', 'usuarios.json');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Uso: npm run crear-admin -- correo@ejemplo.com contraseña123');
    console.log('O: node scripts/crear-admin.js correo@ejemplo.com contraseña123');
    process.exit(1);
  }

  const [correo, password] = args;

  // Validar formato de correo
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    console.error('Error: El correo no es válido.');
    process.exit(1);
  }

  // Validar longitud de contraseña
  if (password.length < 6) {
    console.error('Error: La contraseña debe tener al menos 6 caracteres.');
    process.exit(1);
  }

  // Generar hash con bcrypt (salt 10)
  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  console.log(`Creando administrador: ${correo}...`);

  // Intentar guardar en MySQL primero
  let mysqlSuccess = false;
  try {
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
      database: DB_CONFIG.database,
    });

    // Verificar si la tabla existe, si no crearla
    await connection.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        correo VARCHAR(120) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_usuarios_correo (correo)
      ) ENGINE=InnoDB;
    `);

    // Insertar usuario
    await connection.execute(
      'INSERT INTO usuarios (correo, password_hash) VALUES (?, ?)',
      [correo, passwordHash]
    );

    await connection.end();
    mysqlSuccess = true;
    console.log('✓ Usuario creado exitosamente en MySQL.');
  } catch (error) {
    console.warn(`MySQL no disponible o error: ${error.message}`);
    console.log('Se guardará en archivo JSON local...');
  }

  // Si falla MySQL, guardar en JSON
  if (!mysqlSuccess) {
    // Asegurar que el directorio existe
    const dbDir = path.dirname(USUARIOS_JSON_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Leer o crear archivo JSON
    let usuarios = [];
    if (fs.existsSync(USUARIOS_JSON_PATH)) {
      usuarios = JSON.parse(fs.readFileSync(USUARIOS_JSON_PATH, 'utf8'));
    }

    // Verificar si el correo ya existe
    if (usuarios.some(u => u.correo.toLowerCase() === correo.toLowerCase())) {
      console.error('Error: Ya existe un usuario con ese correo.');
      process.exit(1);
    }

    // Agregar nuevo usuario
    usuarios.push({
      id: usuarios.length > 0 ? Math.max(...usuarios.map(u => u.id)) + 1 : 1,
      correo,
      password_hash: passwordHash,
      creado_en: new Date().toISOString(),
    });

    // Guardar archivo
    fs.writeFileSync(USUARIOS_JSON_PATH, JSON.stringify(usuarios, null, 2));
    console.log('✓ Usuario creado exitosamente en database/usuarios.json');
  }

  console.log('\n=== Usuario Administrador Creado ===');
  console.log(`Correo: ${correo}`);
  console.log('(La contraseña se ha guardado de forma segura con hash bcrypt)');
  console.log('=====================================\n');
}

main().catch(error => {
  console.error('Error fatal:', error.message);
  process.exit(1);
});
