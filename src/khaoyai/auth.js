const crypto = require('crypto');
const { ApiError, getConnection, sql } = require('./common');

const COOKIE_NAME = 'khaoyai_session';
const SESSION_HOURS = 12;
const ROLES = ['field_team', 'reviewer', 'researcher', 'road', 'admin'];

function parseCookies(request) {
    const cookies = {};
    for (const part of (request.headers.get('cookie') || '').split(';')) {
        const index = part.indexOf('=');
        if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

function sessionCookie(token, maxAge = SESSION_HOURS * 3600) {
    const secure = process.env.NODE_ENV === 'production' || process.env.WEBSITE_INSTANCE_ID;
    const sameSite = secure ? 'None' : 'Lax';
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest();
}

function verifyPassword(password, salt, expectedHash, iterations) {
    if (typeof password !== 'string' || password.length > 256) return false;
    const actual = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    return expectedHash.length === actual.length && crypto.timingSafeEqual(expectedHash, actual);
}

async function login(username, password) {
    const normalized = String(username ?? '').trim().toLowerCase();
    if (!normalized || typeof password !== 'string') throw new ApiError(400, 'Username and password are required.');
    const pool = await getConnection();
    const result = await pool.request().input('Username', sql.NVarChar(100), normalized)
        .query(`SELECT UserId AS UserID,Username,DisplayName,RoleCode AS Role,IsActive,PasswordSalt,PasswordHash,PasswordIterations
                FROM dbo.AppUsers WHERE Username=@Username`);
    const user = result.recordset[0];
    if (!user || !user.IsActive || !ROLES.includes(roleOf(user.Role)) ||
        !Number.isInteger(user.PasswordIterations) || user.PasswordIterations < 1 ||
        !verifyPassword(password, user.PasswordSalt, user.PasswordHash, user.PasswordIterations)) {
        throw new ApiError(401, 'Invalid username or password.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.request()
        .input('UserId', sql.NVarChar(64), user.UserID)
        .input('SessionHash', sql.VarBinary(32), hashToken(token))
        .input('ExpiresAt', sql.DateTime2, new Date(Date.now() + SESSION_HOURS * 3600000))
        .query('INSERT dbo.AppSessions (SessionHash,UserId,ExpiresAt) VALUES (@SessionHash,@UserId,@ExpiresAt)');
    return { token, user: publicUser(user) };
}

async function getSession(request, required = true) {
    const token = parseCookies(request)[COOKIE_NAME];
    if (!token) {
        if (required) throw new ApiError(401, 'Authentication required.');
        return null;
    }
    const pool = await getConnection();
    const result = await pool.request()
        .input('SessionHash', sql.VarBinary(32), hashToken(token))
        .query(`SELECT u.UserId AS UserID,u.Username,u.DisplayName,u.RoleCode AS Role,u.AllowedUnderpasses
                FROM dbo.AppSessions s JOIN dbo.AppUsers u ON u.UserId=s.UserId
                WHERE s.SessionHash=@SessionHash AND s.ExpiresAt>SYSUTCDATETIME() AND u.IsActive=1`);
    const session = result.recordset[0];
    if (!session || !ROLES.includes(roleOf(session.Role))) {
        if (required) throw new ApiError(401, 'Session is invalid or expired.');
        return null;
    }
    return { ...publicUser(session), allowedUnderpasses: allowedUnderpasses(session.AllowedUnderpasses) };
}

async function logout(request) {
    const token = parseCookies(request)[COOKIE_NAME];
    if (!token) return;
    const pool = await getConnection();
    await pool.request().input('SessionHash', sql.VarBinary(32), hashToken(token))
        .query('DELETE dbo.AppSessions WHERE SessionHash=@SessionHash');
}

function allowedUnderpasses(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter(code => typeof code === 'string' && /^[A-Z0-9-]{1,20}$/i.test(code)).map(code => code.toUpperCase())
            : [];
    } catch {
        return [];
    }
}

function roleOf(code) {
    return code === 'road_viewer' ? 'road' : code;
}

function requireRole(user, allowed) {
    if (!user || !allowed.includes(user.role)) throw new ApiError(403, 'You do not have permission for this operation.');
}

function publicUser(row) {
    return { id: row.UserID, username: row.Username, displayName: row.DisplayName, role: roleOf(row.Role) };
}

module.exports = { COOKIE_NAME, ROLES, getSession, login, logout, requireRole, sessionCookie };
