const { sql, getConnection } = require('../db');

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function json(status, body, headers = {}) {
    return { status, jsonBody: body, headers: { 'cache-control': 'no-store', ...headers } };
}

async function readJson(request) {
    try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object.');
        return body;
    } catch {
        throw new ApiError(400, 'Request body must be valid JSON.');
    }
}

function positiveInt(value, name) {
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1 || result > 2147483647) {
        throw new ApiError(400, `${name} must be a positive integer.`);
    }
    return result;
}

function optionalText(value, name, maxLength) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.trim().length > maxLength) {
        throw new ApiError(400, `${name} must be text up to ${maxLength} characters.`);
    }
    return value.trim() || null;
}

function uuid(value, name) {
    const result = String(value ?? '').trim().toLowerCase();
    if (!UUID_PATTERN.test(result)) throw new ApiError(400, `${name} must be a UUID.`);
    return result;
}

function queryValue(request, name) {
    return new URL(request.url).searchParams.get(name);
}

function pathValue(request, name) {
    return request.params?.[name];
}

function handleError(error, context) {
    if (error instanceof ApiError) return json(error.status, { error: error.message });
    if (error instanceof sql.ConnectionError) {
        context.error('SQL connection error:', error.code);
        return json(503, { error: 'Database connection unavailable.' });
    }
    context.error(error);
    return json(500, { error: 'Internal server error.' });
}

module.exports = {
    ApiError,
    UUID_PATTERN,
    getConnection,
    handleError,
    optionalText,
    json,
    pathValue,
    positiveInt,
    queryValue,
    readJson,
    sql,
    uuid
};
