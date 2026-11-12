const { roadEventScope } = require('./road-event-scope');
const { ApiError, getConnection, optionalText, positiveInt, sql, uuid } = require('./common');

const { underpassScope } = require('./catalog');

const outcomeByStatus = { pending: 'uncertain', confirmed: 'animal_detected', rejected: 'no_animal' };
const reviewJoin = 'LEFT JOIN dbo.AppEventReviews review ON review.EventID=e.EventID';
const reviewStatus = `
    CASE review.Outcome WHEN 'wildlife' THEN 'confirmed' WHEN 'animal_detected' THEN 'confirmed' WHEN 'no_wildlife' THEN 'rejected' WHEN 'no_animal' THEN 'rejected' ELSE 'pending' END`;
const confirmedReview = "review.Outcome IN ('wildlife','animal_detected')";
const apiOutcome = "CASE review.Outcome WHEN 'animal_detected' THEN 'wildlife' WHEN 'no_animal' THEN 'no_wildlife' ELSE review.Outcome END";
const reviewColumns = 'review.Species AS speciesName,review.Behavior AS behavior,review.Notes AS reviewNote';

async function batchStatus(batchId, user) {
    batchId = uuid(batchId, 'batchId');
    const pool = await getConnection();
    const request = pool.request().input('BatchID', sql.UniqueIdentifier, batchId);
    let ownership = '';
    if (user.role === 'field_team') {
        request.input('Username', sql.NVarChar(100), user.username);
        ownership = 'AND b.FieldTeamUser=@Username';
    }
    const scope = underpassScope(request, user);
    const result = await request.query(`
        SELECT b.BatchID AS batchId,
               CASE WHEN COUNT(DISTINCT e.EventID)>0 THEN 'completed' WHEN failure.FailedAt IS NOT NULL THEN 'failed' ELSE 'queued' END AS status,
               b.UploadedAt AS createdAt,failure.FailedAt AS failedAt,
               COUNT(DISTINCT m.MediaID) AS mediaCount, COUNT(DISTINCT e.EventID) AS eventCount
        FROM dbo.UploadBatches b
        LEFT JOIN dbo.MediaFiles m ON m.BatchID=b.BatchID
        LEFT JOIN dbo.Events e ON e.BatchID=b.BatchID AND e.CameraID=b.CameraID
        LEFT JOIN dbo.AppBatchFailures failure ON failure.BatchID=b.BatchID
        JOIN dbo.Cameras c ON c.CameraID=b.CameraID JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        WHERE b.BatchID=@BatchID ${ownership} AND ${scope}
        GROUP BY b.BatchID,b.UploadedAt,failure.FailedAt`);
    if (!result.recordset.length) throw new ApiError(404, 'Batch not found.');
    return result.recordset[0];
}

async function listEvents(filters, user) {
    const pool = await getConnection();
    const request = pool.request();
    const where = [user.role === 'road' ? roadEventScope(request, user) : underpassScope(request, user)];
    if (filters.cameraId) { request.input('CameraID', sql.Int, positiveInt(filters.cameraId, 'cameraId')); where.push('e.CameraID=@CameraID'); }
    if (filters.roundId) { request.input('RoundID', sql.Int, positiveInt(filters.roundId, 'roundId')); where.push('b.RoundID=@RoundID'); }
    if (user.role !== 'road' && filters.reviewStatus) {
        request.input('ReviewStatus', sql.NVarChar(20), filters.reviewStatus);
        where.push(`(${reviewStatus})=@ReviewStatus`);
    }
    const result = await request.query(`
        SELECT e.EventID AS id,e.BatchID AS batchId,e.CameraID AS cameraId,c.CameraCode AS cameraCode,
               b.RoundID AS roundId,e.StartTime AS startTime,e.EndTime AS endTime,e.MediaCount AS mediaCount,
               ${reviewStatus} AS reviewStatus,${reviewColumns},
               ${apiOutcome} AS outcome
        FROM dbo.Events e JOIN dbo.UploadBatches b ON b.BatchID=e.BatchID AND b.CameraID=e.CameraID
        JOIN dbo.Cameras c ON c.CameraID=e.CameraID JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        ${reviewJoin}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.StartTime DESC`);
    return result.recordset;
}

async function getEvent(eventId, user) {
    eventId = uuid(eventId, 'eventId');
    const pool = await getConnection();
    const request = pool.request().input('EventID', sql.UniqueIdentifier, eventId);
    const scope = user.role === 'road' ? roadEventScope(request, user) : underpassScope(request, user);
    const eventResult = await request.query(`
        SELECT e.EventID AS id,e.BatchID AS batchId,e.CameraID AS cameraId,c.CameraCode AS cameraCode,
               b.RoundID AS roundId,e.StartTime AS startTime,e.EndTime AS endTime,e.MediaCount AS mediaCount,
               ${reviewStatus} AS reviewStatus,${reviewColumns},
               ${apiOutcome} AS outcome,
               review.ReviewerUserId AS reviewedBy,review.ReviewedAt AS reviewedAt
        FROM dbo.Events e JOIN dbo.UploadBatches b ON b.BatchID=e.BatchID AND b.CameraID=e.CameraID
        JOIN dbo.Cameras c ON c.CameraID=e.CameraID JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        ${reviewJoin}
        WHERE e.EventID=@EventID AND ${scope}`);
    const event = eventResult.recordset[0];
    if (!event) throw new ApiError(404, 'Event not found.');

    const mediaResult = await pool.request().input('EventID', sql.UniqueIdentifier, eventId)
        .input('BatchID', sql.UniqueIdentifier, event.batchId).query(`
        SELECT m.MediaID AS id,m.FileName AS fileName,
               m.CapturedAt AS capturedAt
        FROM dbo.EventMediaMap map JOIN dbo.MediaFiles m ON m.MediaID=map.MediaID
        WHERE map.EventID=@EventID AND m.BatchID=@BatchID ORDER BY m.CapturedAt,m.MediaID`);
    event.media = mediaResult.recordset;
    return event;
}

async function reviewHistory(eventId, user) {
    eventId = uuid(eventId, 'eventId');
    const pool = await getConnection();
    const request = pool.request().input('EventID', sql.UniqueIdentifier, eventId);
    const scope = underpassScope(request, user);
    const result = await request.query(`
        SELECT review.ReviewerUserId AS reviewerId,
               COALESCE(NULLIF(reviewer.DisplayName,''),review.ReviewerUserId) AS reviewerName,
               review.ReviewedAt AS reviewedAt,${reviewStatus} AS reviewStatus,
               ${reviewColumns},${apiOutcome} AS outcome,
               CONVERT(varchar(33),review.ValidFrom,126) AS versionId,
               CAST(CASE WHEN DATEPART(year,review.ValidTo)=9999 THEN 1 ELSE 0 END AS bit) AS isCurrent
        FROM dbo.Events e JOIN dbo.UploadBatches b ON b.BatchID=e.BatchID AND b.CameraID=e.CameraID
        JOIN dbo.Cameras c ON c.CameraID=e.CameraID JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        LEFT JOIN dbo.AppEventReviews FOR SYSTEM_TIME ALL AS review ON review.EventID=e.EventID
        LEFT JOIN dbo.AppUsers reviewer ON reviewer.UserId=review.ReviewerUserId
        WHERE e.EventID=@EventID AND ${scope}
        ORDER BY isCurrent DESC,review.ReviewedAt DESC,review.ValidFrom DESC;`);
    if (!result.recordset.length) throw new ApiError(404, 'Event not found.');
    return result.recordset.filter(version => version.versionId !== null);
}


async function reviewEvent(eventId, body, user) {
    eventId = uuid(eventId, 'eventId');
    const outcome = Object.hasOwn(outcomeByStatus, body.reviewStatus) ? outcomeByStatus[body.reviewStatus] : undefined;
    if (!['animal_detected', 'no_animal', 'uncertain'].includes(outcome)) throw new ApiError(400, 'reviewStatus must be pending, confirmed or rejected.');
    const pool = await getConnection();
    const request = pool.request()
        .input('EventID', sql.UniqueIdentifier, eventId).input('Outcome', sql.VarChar(20), outcome)
        .input('Species', sql.NVarChar(200), optionalText(body.speciesName, 'speciesName', 200))
        .input('Behavior', sql.NVarChar(500), optionalText(body.behavior, 'behavior', 500))
        .input('HasBehavior', sql.Bit, Object.hasOwn(body, 'behavior'))
        .input('Notes', sql.NVarChar(1000), optionalText(body.reviewNote, 'reviewNote', 1000))
        .input('ReviewerUserId', sql.NVarChar(64), user.id);
    const scope = underpassScope(request, user);
    const result = await request.query(`
        MERGE dbo.AppEventReviews WITH (HOLDLOCK) AS target
        USING (SELECT e.EventID FROM dbo.Events e JOIN dbo.Cameras c ON c.CameraID=e.CameraID
            JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID WHERE e.EventID=@EventID AND ${scope}) AS source
        ON target.EventID=source.EventID
        WHEN MATCHED THEN UPDATE SET Outcome=@Outcome,Species=@Species,
            Behavior=CASE WHEN @HasBehavior=1 THEN @Behavior ELSE target.Behavior END,
            Notes=@Notes,ReviewerUserId=@ReviewerUserId,ReviewedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (EventID,Outcome,Species,Behavior,Notes,ReviewerUserId,ReviewedAt)
            VALUES (source.EventID,@Outcome,@Species,@Behavior,@Notes,@ReviewerUserId,SYSUTCDATETIME())
        OUTPUT INSERTED.EventID AS id,CASE INSERTED.Outcome WHEN 'animal_detected' THEN 'wildlife' WHEN 'no_animal' THEN 'no_wildlife' ELSE INSERTED.Outcome END AS outcome,
            INSERTED.Species AS speciesName,INSERTED.Behavior AS behavior,INSERTED.Notes AS reviewNote;`);
    const saved = result.recordset[0];
    if (!saved) throw new ApiError(404, 'Event not found.');
    return { ...saved, reviewStatus: body.reviewStatus };
}

module.exports = { batchStatus, confirmedReview, getEvent, listEvents, reviewEvent, reviewHistory, reviewJoin, reviewStatus };
