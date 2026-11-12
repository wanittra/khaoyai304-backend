const { ApiError, getConnection, optionalText, positiveInt, sql } = require('./common');
const { assertFieldAssignment } = require('./catalog');

async function coverageRequest(values, user) {
    const roundId = positiveInt(values.roundId, 'roundId');
    const cameraId = positiveInt(values.cameraId, 'cameraId');
    const date = values.date;
    if (typeof date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
        throw new ApiError(400, 'date must be a valid date in YYYY-MM-DD format.');
    }
    const parsed = new Date(date + 'T00:00:00Z');
    if (date.startsWith('0000-') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new ApiError(400, 'date must be a valid date in YYYY-MM-DD format.');
    }

    await assertFieldAssignment(user, roundId, cameraId);
    const pool = await getConnection();
    return pool.request().input('RoundID', sql.Int, roundId).input('CameraID', sql.Int, cameraId)
        .input('SurveyDate', sql.Date, parsed);
}

async function getCoverage(values, user) {
    const request = await coverageRequest(values, user);
    const result = await request.query(`
        SELECT Status AS status,Notes AS note
        FROM dbo.AppCameraCoverage
        WHERE RoundID=@RoundID AND CameraID=@CameraID AND SurveyDate=@SurveyDate`);
    return result.recordset[0] ?? null;
}

async function saveCoverage(values, user) {
    if (!['active', 'offline', 'unknown'].includes(values.status)) {
        throw new ApiError(400, 'status must be active, offline or unknown.');
    }
    const note = optionalText(values.note, 'note', 1000);
    const request = await coverageRequest(values, user);
    const result = await request.input('Status', sql.VarChar(20), values.status)
        .input('Note', sql.NVarChar(1000), note).input('UserID', sql.NVarChar(64), user.id)
        .query(`
            MERGE dbo.AppCameraCoverage WITH (HOLDLOCK) AS target
            USING (VALUES (@RoundID,@CameraID,@SurveyDate)) AS source(RoundID,CameraID,SurveyDate)
            ON target.RoundID=source.RoundID AND target.CameraID=source.CameraID
               AND target.SurveyDate=source.SurveyDate
            WHEN MATCHED THEN UPDATE SET Status=@Status,Notes=@Note,RecordedBy=@UserID,UpdatedAt=SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (RoundID,CameraID,SurveyDate,Status,Notes,RecordedBy,UpdatedAt)
                VALUES (@RoundID,@CameraID,@SurveyDate,@Status,@Note,@UserID,SYSUTCDATETIME())
            OUTPUT INSERTED.Status AS status,INSERTED.Notes AS note;`);
    return result.recordset[0];
}

module.exports = { getCoverage, saveCoverage };
