const { app, output } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { getConnection, sql } = require('../db');
const { getSession, requireRole } = require('../khaoyai/auth');
const { assertFieldAssignment } = require('../khaoyai/catalog');
const { handleError } = require('../khaoyai/common');

const queueOutput = output.storageQueue({
    queueName: 'camera-upload-jobs',
    connection: 'AzureWebJobsStorage'
});

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 30;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const captureTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;

app.http('uploadApi', {
    methods: ['POST'],
    authLevel: 'anonymous',
    // Keep the existing public route so current field clients do not break.
    route: 'uploadApi',
    extraOutputs: [queueOutput],
    handler: async (request, context) => {
        let user;
        try {
            user = await getSession(request);
            requireRole(user, ['field_team', 'admin']);
        } catch (error) {
            return handleError(error, context);
        }
        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
            return { status: 415, jsonBody: { error: 'Use multipart/form-data.' } };
        }

        let form;
        try {
            form = await request.formData();
        } catch {
            return { status: 400, jsonBody: { error: 'Invalid multipart form.' } };
        }

        const batchId = String(form.get('batchId') ?? '').trim().toLowerCase();
        const roundId = Number(form.get('roundId'));
        const cameraId = Number(form.get('cameraId'));
        const files = form.getAll('file');
        const captureTimes = form.getAll('capturedAt');

        const validIds = [roundId, cameraId].every(
            id => Number.isInteger(id) && id > 0 && id <= 2147483647
        );
        if (!uuidPattern.test(batchId) || !validIds) {
            return {
                status: 400,
                jsonBody: { error: 'Provide batchId (UUID), roundId and cameraId.' }
            };
        }

        if (!files.length || files.length > MAX_FILES || files.length !== captureTimes.length) {
            return {
                status: 400,
                jsonBody: { error: 'Provide 1–30 files and one capturedAt per file, in the same order.' }
            };
        }

        const media = [];
        let totalBytes = 0;
        for (const [index, file] of files.entries()) {
            const captureTime = captureTimes[index];
            const capturedAt = new Date(typeof captureTime === 'string' ? captureTime : '');
            if (typeof file === 'string' || !file.name || file.size === 0 ||
                !/^(image|video)\//.test(file.type) || typeof captureTime !== 'string' ||
                !captureTimePattern.test(captureTime) || !Number.isFinite(capturedAt.getTime())) {
                return {
                    status: 400,
                    jsonBody: { error: 'Each file must be an image or video with an ISO 8601 capturedAt including a time zone.' }
                };
            }
            totalBytes += file.size;
            media.push({ file, capturedAt });
        }

        if (totalBytes > MAX_UPLOAD_BYTES) {
            return { status: 413, jsonBody: { error: 'Total file size exceeds 25 MiB.' } };
        }

        try {
            await assertFieldAssignment(user, roundId, cameraId);
        } catch (error) {
            return handleError(error, context);
        }

        let transaction;
        let transactionOpen = false;
        try {
            const pool = await getConnection();
            transaction = new sql.Transaction(pool);
            await transaction.begin();
            transactionOpen = true;

            const existing = await transaction.request()
                .input('BatchID', sql.UniqueIdentifier, batchId)
                .query(`
                    SELECT RoundID,CameraID,FieldTeamUser AS Owner
                    FROM dbo.UploadBatches WITH (UPDLOCK, HOLDLOCK)
                    WHERE BatchID = @BatchID
                `);

            const batch = existing.recordset[0];
            if (batch) {
                await transaction.commit();
                transactionOpen = false;
                if (batch.RoundID !== roundId || batch.CameraID !== cameraId ||
                    batch.Owner !== user.username) {
                    return {
                        status: 409,
                        jsonBody: { error: 'This batchId already belongs to another upload.' }
                    };
                }
            } else {
                const container = BlobServiceClient
                    .fromConnectionString(process.env.AzureWebJobsStorage)
                    .getContainerClient(process.env.WILDLIFE_MEDIA_CONTAINER || 'wildlife-media');

                await transaction.request()
                    .input('BatchID', sql.UniqueIdentifier, batchId)
                    .input('RoundID', sql.Int, roundId)
                    .input('CameraID', sql.Int, cameraId)
                    .input('Owner', sql.NVarChar(100), user.username)
                    .query(`INSERT dbo.UploadBatches (BatchID,RoundID,CameraID,FieldTeamUser,UploadedAt)
                       VALUES (@BatchID,@RoundID,@CameraID,@Owner,SYSUTCDATETIME())`);

                for (const [index, { file, capturedAt }] of media.entries()) {
                    const blobName = `uploads/${batchId}/${index + 1}`;
                    const blob = container.getBlockBlobClient(blobName);
                    await blob.uploadData(Buffer.from(await file.arrayBuffer()), {
                        blobHTTPHeaders: { blobContentType: file.type }
                    });

                    await transaction.request()
                        .input('BatchID', sql.UniqueIdentifier, batchId)
                        .input('BlobUrl', sql.NVarChar(sql.MAX), blob.url)
                        .input('FileName', sql.NVarChar(sql.MAX), file.name)
                        .input('CapturedAt', sql.DateTime2, capturedAt)
                        .query(`INSERT dbo.MediaFiles (MediaID,BatchID,BlobUrl,FileName,CapturedAt)
                           VALUES (NEWID(),@BatchID,@BlobUrl,@FileName,@CapturedAt)`);
                }

                await transaction.commit();
                transactionOpen = false;
            }

            context.extraOutputs.set(queueOutput, { batchId });
            return { status: 202, jsonBody: { batchId, status: 'queued' } };
        } catch (error) {
            if (transactionOpen) {
                try {
                    await transaction.rollback();
                } catch (rollbackError) {
                    context.error('Upload transaction rollback failed:', rollbackError.message);
                }
            }
            context.error(`Upload failed for batch ${batchId}:`, error.message);
            return { status: 500, jsonBody: { batchId, error: 'Upload failed. Check the Functions host log.' } };
        }
    }
});
