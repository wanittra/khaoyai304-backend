const { underpassScope } = require('./catalog');
const { ApiError, getConnection, optionalText, positiveInt, sql, uuid } = require('./common');

const { animalDetected } = require('./road-event-scope');

const requestColumns = `
    road.RequestID AS id,road.RoundID AS roundId,r.RoundName AS roundName,
    r.StartDate AS startsOn,r.EndDate AS endsOn,road.UnderpassID AS underpassId,
    u.UnderpassCode AS underpassCode,u.UnderpassName AS underpassName,
    road.Reason AS reason,road.RequestedAt AS requestedAt,road.Status AS status,
    requester.DisplayName AS requesterName`;
const requestFrom = `FROM dbo.RoadDataRequests road
    JOIN dbo.SurveyRounds r ON r.RoundID=road.RoundID
    JOIN dbo.Underpasses u ON u.UnderpassID=road.UnderpassID
    JOIN dbo.AppUsers requester ON requester.UserId=road.RequesterUserId`;

function requestScope(request, user) {
    if (user.role !== 'road') return underpassScope(request, user);
    request.input('Requester', sql.NVarChar(64), user.id);
    return 'road.RequesterUserId=@Requester';
}

async function listUnderpasses() {
    const request = (await getConnection()).request();
    const result = await request.query(`
        SELECT u.UnderpassID AS id,u.UnderpassCode AS code,u.UnderpassName AS name
        FROM dbo.Underpasses u ORDER BY u.UnderpassCode`);
    return result.recordset;
}

async function createRequest(body, user) {
    const roundId = positiveInt(body.roundId, 'roundId');
    const underpassId = positiveInt(body.underpassId, 'underpassId');
    const reason = optionalText(body.reason, 'reason', 1000);
    if (!reason) throw new ApiError(400, 'กรุณาระบุเหตุผลที่ขอข้อมูล');
    const request = (await getConnection()).request()
        .input('RoundID', sql.Int, roundId).input('UnderpassID', sql.Int, underpassId)
        .input('Requester', sql.NVarChar(64), user.id).input('Reason', sql.NVarChar(1000), reason);
    const result = await request.query(`
        INSERT dbo.RoadDataRequests (RequesterUserId,RoundID,UnderpassID,Reason)
        OUTPUT INSERTED.RequestID AS id,INSERTED.Status AS status
        SELECT @Requester,r.RoundID,u.UnderpassID,@Reason
        FROM dbo.SurveyRounds r CROSS JOIN dbo.Underpasses u
        WHERE r.RoundID=@RoundID AND u.UnderpassID=@UnderpassID`);
    if (!result.recordset.length) throw new ApiError(404, 'ไม่พบรอบสำรวจหรือทางลอดที่เลือก');
    return result.recordset[0];
}

async function listRequests(user) {
    const request = (await getConnection()).request();
    const scope = requestScope(request, user);
    const result = await request.query(`
        SELECT ${requestColumns} ${requestFrom}
        WHERE ${scope} ORDER BY road.RequestedAt DESC,road.RequestID DESC`);
    return result.recordset;
}

async function getRequest(requestId, user) {
    const pool = await getConnection();
    const request = pool.request().input('RequestID', sql.UniqueIdentifier, uuid(requestId, 'requestId'));
    const scope = requestScope(request, user);
    const isRoad = user.role === 'road';
    const result = await request.query(`
        SELECT ${requestColumns} ${requestFrom} WHERE road.RequestID=@RequestID AND ${scope};
        SELECT e.EventID AS id,c.CameraCode AS cameraCode,e.StartTime AS startTime,
               e.EndTime AS endTime,e.MediaCount AS mediaCount,review.Species AS speciesName,
               review.Behavior AS behavior
        ${requestFrom}
        JOIN dbo.UploadBatches b ON b.RoundID=road.RoundID
        JOIN dbo.Events e ON e.BatchID=b.BatchID AND e.CameraID=b.CameraID
        JOIN dbo.Cameras c ON c.CameraID=e.CameraID AND c.UnderpassID=road.UnderpassID
        JOIN dbo.AppEventReviews review ON review.EventID=e.EventID
        WHERE road.RequestID=@RequestID AND ${scope} AND ${animalDetected}
          AND ((road.Status='pending' AND ${isRoad ? '1=0' : '1=1'})
            OR (road.Status='shared' AND EXISTS (
                SELECT 1 FROM dbo.RoadDataRequestEvents shared
                WHERE shared.RequestID=road.RequestID AND shared.EventID=e.EventID
            )))
        ORDER BY e.StartTime DESC,e.EventID;`);
    const item = result.recordsets[0][0];
    if (!item) throw new ApiError(404, 'ไม่พบคำขอ');
    return { ...item, events: result.recordsets[1] };
}

async function shareRequest(requestId, body, user) {
    requestId = uuid(requestId, 'requestId');
    if (!Array.isArray(body.eventIds) || !body.eventIds.length) {
        throw new ApiError(400, 'กรุณาเลือกหลักฐานอย่างน้อยหนึ่งเหตุการณ์');
    }
    const eventIds = [...new Set(body.eventIds.map((id) => uuid(id, 'eventId')))];
    const request = (await getConnection()).request()
        .input('RequestID', sql.UniqueIdentifier, requestId)
        .input('EventIDs', sql.NVarChar(sql.MAX), JSON.stringify(eventIds))
        .input('ExpectedCount', sql.Int, eventIds.length)
        .input('SharedBy', sql.NVarChar(64), user.id);
    const scope = underpassScope(request, user);
    const result = await request.query(`
        SET XACT_ABORT ON;
        BEGIN TRY
            BEGIN TRANSACTION;
            DECLARE @Round int,@Underpass int,@Status varchar(16);
            SELECT @Round=road.RoundID,@Underpass=road.UnderpassID,@Status=road.Status
            FROM dbo.RoadDataRequests road WITH (UPDLOCK,HOLDLOCK)
            JOIN dbo.Underpasses u ON u.UnderpassID=road.UnderpassID
            WHERE road.RequestID=@RequestID AND ${scope};

            IF @Status IS NULL THROW 51001,'Request not found.',1;
            IF @Status <> 'pending' THROW 51002,'Request is no longer pending.',1;

            DECLARE @Eligible TABLE (EventID uniqueidentifier PRIMARY KEY);
            INSERT @Eligible (EventID)
            SELECT e.EventID FROM OPENJSON(@EventIDs) ids
            JOIN dbo.Events e WITH (HOLDLOCK) ON e.EventID=CONVERT(uniqueidentifier,ids.[value])
            JOIN dbo.UploadBatches b WITH (HOLDLOCK) ON b.BatchID=e.BatchID AND b.CameraID=e.CameraID
            JOIN dbo.Cameras c WITH (HOLDLOCK) ON c.CameraID=e.CameraID
            JOIN dbo.AppEventReviews review WITH (HOLDLOCK) ON review.EventID=e.EventID
            WHERE b.RoundID=@Round AND c.UnderpassID=@Underpass AND ${animalDetected};
            IF (SELECT COUNT(*) FROM @Eligible) <> @ExpectedCount
                THROW 51003,'One or more events are not eligible.',1;

            INSERT dbo.RoadDataRequestEvents (RequestID,EventID,SharedByUserId)
            SELECT @RequestID,EventID,@SharedBy FROM @Eligible;
            UPDATE dbo.RoadDataRequests SET Status='shared' WHERE RequestID=@RequestID;
            COMMIT TRANSACTION;
            SELECT @RequestID AS id,'shared' AS status;
        END TRY
        BEGIN CATCH
            IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
            THROW;
        END CATCH;`).catch((error) => {
        if (error.number === 51001) throw new ApiError(404, 'ไม่พบคำขอ');
        if (error.number === 51002) throw new ApiError(409, 'คำขอนี้ได้รับการแชร์แล้ว');
        if (error.number === 51003) throw new ApiError(400, 'มีเหตุการณ์ที่ไม่ตรงกับรอบ ทางลอด หรือผลตรวจที่ยืนยันแล้ว');
        throw error;
    });
    return result.recordset[0];
}

module.exports = { listUnderpasses, createRequest, listRequests, getRequest, shareRequest };
