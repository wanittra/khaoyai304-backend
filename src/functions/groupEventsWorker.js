const { app } = require('@azure/functions');
const { getConnection, sql } = require('../db');

const queueName = 'camera-upload-jobs';

function readBatchId(queueItem) {
    const job = typeof queueItem === 'string' ? JSON.parse(queueItem) : queueItem;
    const batchId = job?.batchId;
    if (typeof batchId !== 'string' || !uuidPattern.test(batchId)) {
        throw new Error('Queue message must contain a valid batchId.');
    }
    return batchId;
}

const TIME_WINDOW_MS = 5 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

app.storageQueue('groupEventsWorker', {
    queueName,
    connection: 'AzureWebJobsStorage',
    handler: async (queueItem, context) => {
        const batchId = readBatchId(queueItem);

        const pool = await getConnection();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // Serialize deliveries for the same batch.
            const batchInfo = await transaction.request()
                .input('BatchID', sql.UniqueIdentifier, batchId)
                .query(`
                    SELECT CameraID
                    FROM dbo.UploadBatches WITH (UPDLOCK, HOLDLOCK)
                    WHERE BatchID = @BatchID
                `);

            const batch = batchInfo.recordset[0];
            if (!batch) {
                throw new Error(`Upload batch ${batchId} was not found.`);
            }

            const mediaResult = await transaction.request()
                .input('BatchID', sql.UniqueIdentifier, batchId)
                .query(`
                    SELECT MediaID, CapturedAt
                    FROM dbo.MediaFiles
                    WHERE BatchID = @BatchID
                    ORDER BY CapturedAt, MediaID
                `);
            const files = mediaResult.recordset;

            if (!files.length) throw new Error('Upload batch has no media.');

            const existing = await transaction.request()
                .input('BatchID', sql.UniqueIdentifier, batchId)
                .query(`
                    SELECT COUNT(DISTINCT e.EventID) AS EventCount,
                           COUNT(DISTINCT m.MediaID) AS LinkedMediaCount
                    FROM dbo.Events AS e
                    LEFT JOIN dbo.EventMediaMap AS map ON map.EventID = e.EventID
                    LEFT JOIN dbo.MediaFiles AS m
                        ON m.MediaID = map.MediaID AND m.BatchID = e.BatchID
                    WHERE e.BatchID = @BatchID
                `);

            const { EventCount, LinkedMediaCount } = existing.recordset[0];
            if (EventCount && LinkedMediaCount !== files.length) {
                throw new Error(`Batch ${batchId} already has incomplete event records.`);
            }
            if (!EventCount) {
                await writeEvents(transaction, batchId, batch.CameraID, files);
            }

            await transaction.request().input('BatchID', sql.UniqueIdentifier, batchId)
                .query('DELETE dbo.AppBatchFailures WHERE BatchID=@BatchID');
            await transaction.commit();
            context.log(`Batch ${batchId} processed. Media files: ${files.length}.`);
        } catch (error) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                context.error('Event transaction rollback failed:', rollbackError.message);
            }
            throw error;
        }
    }
});

app.storageQueue('recordBatchFailure', {
    queueName: queueName + '-poison',
    connection: 'AzureWebJobsStorage',
    handler: async (queueItem, context) => {
        let batchId;
        try {
            batchId = readBatchId(queueItem);
        } catch {
            context.warn('Ignoring a poison message without a valid batch ID.');
            return;
        }
        const pool = await getConnection();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            const request = transaction.request().input('BatchID', sql.UniqueIdentifier, batchId);
            const batch = await request.query(`SELECT BatchID FROM dbo.UploadBatches WITH (UPDLOCK,HOLDLOCK)
                WHERE BatchID=@BatchID`);
            if (batch.recordset.length) {
                await request.query(`
                    IF NOT EXISTS (SELECT 1 FROM dbo.Events WHERE BatchID=@BatchID)
                       AND NOT EXISTS (SELECT 1 FROM dbo.AppBatchFailures WHERE BatchID=@BatchID)
                        INSERT dbo.AppBatchFailures (BatchID,FailedAt) VALUES (@BatchID,SYSUTCDATETIME());`);
            }
            await transaction.commit();
        } catch (error) {
            await transaction.rollback().catch(() => {});
            throw error;
        }
    }
});

async function writeEvents(transaction, batchId, cameraId, files) {
    const groups = [];
    let current;
    for (const file of files) {
        const capturedAt = new Date(file.CapturedAt);
        if (!current || capturedAt - current.endTime > TIME_WINDOW_MS) {
            current = { startTime: capturedAt, endTime: capturedAt, mediaIds: [] };
            groups.push(current);
        }
        current.endTime = capturedAt;
        current.mediaIds.push(file.MediaID);
    }

    for (const group of groups) {
        const result = await transaction.request()
            .input('BatchID', sql.UniqueIdentifier, batchId)
            .input('CameraID', sql.Int, cameraId)
            .input('StartTime', sql.DateTime2, group.startTime)
            .input('EndTime', sql.DateTime2, group.endTime)
            .input('MediaCount', sql.Int, group.mediaIds.length)
            .query(`
                INSERT INTO dbo.Events (EventID, BatchID, CameraID, StartTime, EndTime, MediaCount)
                OUTPUT INSERTED.EventID
                VALUES (NEWID(), @BatchID, @CameraID, @StartTime, @EndTime, @MediaCount)
            `);

        const { EventID } = result.recordset[0];
        for (const mediaId of group.mediaIds) {
            await transaction.request()
                .input('EventID', sql.UniqueIdentifier, EventID)
                .input('MediaID', sql.UniqueIdentifier, mediaId)
                .query(`
                    INSERT INTO dbo.EventMediaMap (EventID, MediaID)
                    VALUES (@EventID, @MediaID)
                `);
        }
    }
}
