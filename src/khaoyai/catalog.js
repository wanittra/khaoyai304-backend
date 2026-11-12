const { roadEventScope } = require('./road-event-scope');
const { ApiError, getConnection, positiveInt, sql } = require('./common');

function underpassScope(request, user) {
    if (user.role === 'admin') return '1=1';
    request.input('AllowedUnderpasses', sql.NVarChar(sql.MAX), JSON.stringify(user.allowedUnderpasses ?? []));
    return 'u.UnderpassCode IN (SELECT [value] FROM OPENJSON(@AllowedUnderpasses))';
}

async function listCameras(user) {
    const pool = await getConnection();
    const request = pool.request();
    const allowed = underpassScope(request, user);
    const scope = user.role === 'road' ? `(${allowed} OR EXISTS (
        SELECT 1 FROM dbo.Events e
        JOIN dbo.UploadBatches b ON b.BatchID=e.BatchID AND b.CameraID=e.CameraID
        JOIN dbo.AppEventReviews review ON review.EventID=e.EventID
        WHERE e.CameraID=c.CameraID AND ${roadEventScope(request, user)}
    ))` : allowed;
    const result = await request.query(`
        SELECT c.CameraID AS id,c.CameraCode AS code,c.CameraName AS name,c.CameraType AS cameraType,
               c.Latitude AS latitude,c.Longitude AS longitude,
               u.UnderpassCode AS underpassCode,u.UnderpassName AS underpassName,
               u.Latitude AS underpassLatitude,u.Longitude AS underpassLongitude
        FROM dbo.Cameras c LEFT JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        WHERE ${scope} ORDER BY u.UnderpassCode,c.CameraCode`);
    return result.recordset;
}

async function listRounds() {
    const pool = await getConnection();
    const result = await pool.request().query(`
        SELECT r.RoundID AS id,r.RoundName AS name,r.StartDate AS startsOn,r.EndDate AS endsOn,
               CAST(CASE WHEN CONVERT(date,DATEADD(hour,7,SYSUTCDATETIME()))
                   BETWEEN CONVERT(date,r.StartDate) AND CONVERT(date,r.EndDate) THEN 1 ELSE 0 END AS bit) AS isOpen
        FROM dbo.SurveyRounds r ORDER BY startsOn DESC,r.RoundID DESC`);
    return result.recordset;
}

async function assertFieldAssignment(user, roundId, cameraId) {
    positiveInt(roundId, 'roundId');
    positiveInt(cameraId, 'cameraId');
    const pool = await getConnection();
    const request = pool.request().input('RoundID', sql.Int, roundId).input('CameraID', sql.Int, cameraId);
    const result = await request.query(`
        SELECT 1 AS Allowed FROM dbo.Cameras c
        JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        WHERE c.CameraID=@CameraID AND ${underpassScope(request, user)}
          AND EXISTS (SELECT 1 FROM dbo.SurveyRounds WHERE RoundID=@RoundID)`);
    if (!result.recordset.length) throw new ApiError(403, 'This camera and survey round are not assigned to your account.');
}

module.exports = { assertFieldAssignment, listCameras, listRounds, underpassScope };
