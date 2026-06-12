const crypto = require('crypto');
const { getDb } = require('./db');

const allowedRoles = new Set(['admin', 'usuario']);
const privilegedRoles = new Set(['admin']);

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function normalizeName(name, username) {
  return String(name || username || '').trim();
}

function normalizeRole(role) {
  const cleanRole = String(role || 'usuario').trim().toLowerCase();
  return allowedRoles.has(cleanRole) ? cleanRole : 'usuario';
}

function safeCompare(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('base64');
  return { hash, salt };
}

function publicUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    isAdmin: row.role === 'admin',
    isPrivileged: privilegedRoles.has(row.role),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseUsersFromJson(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed.map(item => normalizeUserInput(item, true)).filter(Boolean);
    }

    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed)
        .map(([username, user]) => normalizeUserInput({ username, ...(user || {}) }, true))
        .filter(Boolean);
    }
  } catch (error) {
    console.warn('AUTH_USERS_JSON no es JSON valido. Se usan usuarios por defecto.');
  }

  return [];
}

function getDefaultUsers() {
  return [
    {
      username: 'admin',
      password: process.env.AUTH_ADMIN_PASSWORD || 'admin',
      role: 'admin',
      name: 'Administrador'
    },
    {
      username: 'usuario',
      password: process.env.AUTH_USUARIO_PASSWORD || 'usuario',
      role: 'usuario',
      name: 'Usuario'
    }
  ];
}

function getSeedUsers() {
  const users = parseUsersFromJson(process.env.AUTH_USERS_JSON);
  const seedUsers = users.length ? users : getDefaultUsers();
  const hasAdmin = seedUsers.some(user => user.role === 'admin');

  if (!hasAdmin) {
    seedUsers.unshift({
      username: 'admin',
      password: process.env.AUTH_ADMIN_PASSWORD || 'admin',
      role: 'admin',
      name: 'Administrador'
    });
  }

  return seedUsers;
}

function normalizeUserInput(input = {}, passwordRequired = false) {
  const username = normalizeUsername(input.username);
  const name = normalizeName(input.name, username);
  const role = normalizeRole(input.role);
  const password = String(input.password || '');

  if (!username) {
    throw new Error('Falta usuario');
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error('El usuario debe tener 3 a 40 caracteres: letras, numeros, punto, guion o guion bajo');
  }

  if (!name) {
    throw new Error('Falta nombre');
  }

  if (passwordRequired && password.length < 3) {
    throw new Error('La contrasena debe tener al menos 3 caracteres');
  }

  if (password && password.length < 3) {
    throw new Error('La contrasena debe tener al menos 3 caracteres');
  }

  return {
    username,
    name,
    role,
    password
  };
}

function migrateLegacyRoles(database) {
  database.prepare(`
    UPDATE users
    SET role = 'usuario',
        updated_at = CURRENT_TIMESTAMP
    WHERE LOWER(role) = 'ald'
  `).run();
}

function ensureUsersSeeded() {
  const database = getDb();
  const count = database.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  if (count > 0) {
    migrateLegacyRoles(database);
    return;
  }

  const statement = database.prepare(`
    INSERT INTO users (
      username,
      name,
      role,
      password_hash,
      password_salt
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  database.exec('BEGIN');

  try {
    for (const user of getSeedUsers()) {
      const cleanUser = normalizeUserInput(user, true);
      const password = hashPassword(cleanUser.password);
      statement.run(
        cleanUser.username,
        cleanUser.name,
        cleanUser.role,
        password.hash,
        password.salt
      );
    }

    database.exec('COMMIT');
    migrateLegacyRoles(database);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function getUserRowByUsername(username) {
  ensureUsersSeeded();
  const cleanUsername = normalizeUsername(username);

  if (!cleanUsername) {
    return null;
  }

  return getDb().prepare(`
    SELECT *
    FROM users
    WHERE username = ?
  `).get(cleanUsername);
}

function getUserRowById(id) {
  ensureUsersSeeded();
  return getDb().prepare(`
    SELECT *
    FROM users
    WHERE id = ?
  `).get(Number(id));
}

function getPublicUserByUsername(username) {
  return publicUser(getUserRowByUsername(username));
}

function authenticateUser(username, password) {
  const user = getUserRowByUsername(username);

  if (!user) {
    return null;
  }

  const passwordHash = hashPassword(password, user.password_salt).hash;

  if (!safeCompare(passwordHash, user.password_hash)) {
    return null;
  }

  return publicUser(user);
}

function listUsers() {
  ensureUsersSeeded();
  return getDb().prepare(`
    SELECT
      id,
      username,
      name,
      role,
      created_at,
      updated_at
    FROM users
    ORDER BY role = 'admin' DESC, username ASC
  `).all().map(publicUser);
}

function createUser(input = {}) {
  const user = normalizeUserInput(input, true);
  const password = hashPassword(user.password);

  try {
    const result = getDb().prepare(`
      INSERT INTO users (
        username,
        name,
        role,
        password_hash,
        password_salt
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      user.username,
      user.name,
      user.role,
      password.hash,
      password.salt
    );

    return publicUser(getUserRowById(result.lastInsertRowid));
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      throw new Error('Ya existe un usuario con ese nombre');
    }

    throw error;
  }
}

function countAdmins(excludedId) {
  const params = [];
  let where = "role = 'admin'";

  if (excludedId) {
    where += ' AND id <> ?';
    params.push(Number(excludedId));
  }

  return getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE ${where}
  `).get(...params).count;
}

function assertCanChangeRole(existingUser, nextRole) {
  if (existingUser.role === 'admin' && nextRole !== 'admin' && countAdmins(existingUser.id) === 0) {
    throw new Error('Debe quedar al menos un usuario admin');
  }
}

function updateUser(id, input = {}) {
  const existingUser = getUserRowById(id);

  if (!existingUser) {
    throw new Error('Usuario no encontrado');
  }

  const user = normalizeUserInput({
    username: input.username ?? existingUser.username,
    name: input.name ?? existingUser.name,
    role: input.role ?? existingUser.role,
    password: input.password || ''
  });

  assertCanChangeRole(existingUser, user.role);

  try {
    if (user.password) {
      const password = hashPassword(user.password);
      getDb().prepare(`
        UPDATE users
        SET username = ?,
            name = ?,
            role = ?,
            password_hash = ?,
            password_salt = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        user.username,
        user.name,
        user.role,
        password.hash,
        password.salt,
        Number(id)
      );
    } else {
      getDb().prepare(`
        UPDATE users
        SET username = ?,
            name = ?,
            role = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        user.username,
        user.name,
        user.role,
        Number(id)
      );
    }
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      throw new Error('Ya existe un usuario con ese nombre');
    }

    throw error;
  }

  return publicUser(getUserRowById(id));
}

function deleteUser(id, currentUsername) {
  const user = getUserRowById(id);

  if (!user) {
    throw new Error('Usuario no encontrado');
  }

  if (normalizeUsername(currentUsername) === user.username) {
    throw new Error('No podes eliminar el usuario con la sesion actual');
  }

  if (user.role === 'admin' && countAdmins(user.id) === 0) {
    throw new Error('Debe quedar al menos un usuario admin');
  }

  getDb().prepare(`
    DELETE FROM users
    WHERE id = ?
  `).run(Number(id));

  return publicUser(user);
}

module.exports = {
  allowedRoles: Array.from(allowedRoles),
  authenticateUser,
  createUser,
  deleteUser,
  getPublicUserByUsername,
  listUsers,
  updateUser
};
