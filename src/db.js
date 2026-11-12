const sql = require('mssql');

let connection;

function getConnection() {
    if (!connection) {
        const connectionString = process.env.SqlConnectionString;
        if (!connectionString) throw new Error('SqlConnectionString is required.');
        const config = sql.ConnectionPool.parseConnectionString(connectionString);
        const pool = new sql.ConnectionPool({
            ...config,
            connectionTimeout: config.connectionTimeout ?? 20000,
            requestTimeout: config.requestTimeout ?? 12000,
        });
        pool.on('error', error => console.error('SQL pool error:', error.code ?? error.name));
        connection = pool.connect().catch(async error => {
            await pool.close().catch(() => {});
            connection = undefined;
            throw error;
        });
    }
    return connection;
}

module.exports = { sql, getConnection };
