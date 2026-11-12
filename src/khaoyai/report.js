const { roadEventScope } = require('./road-event-scope');
const { underpassScope } = require('./catalog');
const { confirmedReview, reviewJoin, reviewStatus } = require('./events');
const { getConnection, positiveInt, sql } = require('./common');

async function summary(roundId, user) {
    const pool = await getConnection();
    const request = pool.request();
    const filters = [user.role === 'road' ? roadEventScope(request, user) : underpassScope(request, user)];
    if (roundId) {
        request.input('RoundID', sql.Int, positiveInt(roundId, 'roundId'));
        filters.push('b.RoundID=@RoundID');
    }
    const result = await request.query(`
        SELECT b.RoundID AS roundId,r.RoundName AS roundName,c.CameraID AS cameraId,c.CameraCode AS cameraCode,
               u.UnderpassCode AS underpassCode,
               COUNT(DISTINCT e.EventID) AS eventCount,
               SUM(CASE WHEN ${confirmedReview} THEN 1 ELSE 0 END) AS confirmedCount,
               SUM(CASE WHEN e.EventID IS NOT NULL AND (${reviewStatus})='pending' THEN 1 ELSE 0 END) AS pendingCount,
               COUNT(DISTINCT CASE WHEN ${confirmedReview} THEN review.Species END) AS speciesCount
        FROM dbo.UploadBatches b JOIN dbo.SurveyRounds r ON r.RoundID=b.RoundID
        JOIN dbo.Cameras c ON c.CameraID=b.CameraID LEFT JOIN dbo.Events e ON e.BatchID=b.BatchID AND e.CameraID=b.CameraID
        ${reviewJoin}
        LEFT JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        GROUP BY b.RoundID,r.RoundName,c.CameraID,c.CameraCode,u.UnderpassCode ORDER BY b.RoundID DESC,c.CameraCode`);
    return result.recordset;
}

module.exports = { summary };
