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
    const status = String(values.status ?? '').trim().toLowerCase();
    if (!['active', 'offline', 'unknown'].includes(status)) {
        throw new ApiError(400, 'status must be active, offline or unknown.');
    }
    const note = optionalText(values.note, 'note', 1000);
    const upsertSql = `
        MERGE dbo.AppCameraCoverage WITH (HOLDLOCK) AS target
        USING (SELECT @RoundID AS RoundID, @CameraID AS CameraID, @SurveyDate AS SurveyDate) AS source
        ON target.RoundID=source.RoundID AND target.CameraID=source.CameraID
           AND target.SurveyDate=source.SurveyDate
        WHEN MATCHED THEN UPDATE SET Status=@Status,Notes=@Note,RecordedBy=@UserID,UpdatedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (RoundID,CameraID,SurveyDate,Status,Notes,RecordedBy,UpdatedAt)
            VALUES (source.RoundID,source.CameraID,source.SurveyDate,@Status,@Note,@UserID,SYSUTCDATETIME())
        OUTPUT INSERTED.Status AS status,INSERTED.Notes AS note;`;

    const executeUpsert = async () => {
        const req = await coverageRequest(values, user);
        const res = await req.input('Status', sql.VarChar(20), status)
            .input('Note', sql.NVarChar(1000), note).input('UserID', sql.NVarChar(64), user.id)
            .query(upsertSql);
        return res.recordset[0];
    };

    try {
        return await executeUpsert();
    } catch (error) {
        if (error?.message && error.message.includes('CK_AppCameraCoverage_Status')) {
            const pool = await getConnection();
            await pool.request().query(`
                ALTER TABLE dbo.AppCameraCoverage DROP CONSTRAINT IF EXISTS CK_AppCameraCoverage_Status;
                ALTER TABLE dbo.AppCameraCoverage WITH NOCHECK ADD CONSTRAINT CK_AppCameraCoverage_Status
                    CHECK (Status IN ('active', 'offline', 'unknown'));
            `);
            return await executeUpsert();
        }
        throw error;
    }
}

module.exports = { getCoverage, saveCoverage };
