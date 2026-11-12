const { roadEventScope } = require('./road-event-scope');
const { BlobServiceClient } = require('@azure/storage-blob');
const { underpassScope } = require('./catalog');
const { reviewJoin } = require('./events');
const { ApiError, getConnection, sql, uuid } = require('./common');

async function openMedia(mediaId, user) {
    mediaId = uuid(mediaId, 'mediaId');
    const pool = await getConnection();
    const request = pool.request().input('MediaID', sql.UniqueIdentifier, mediaId);
    const scope = user.role === 'road' ? '1=1' : underpassScope(request, user);
    const result = await request.query(`
        SELECT m.BlobUrl
        FROM dbo.MediaFiles m JOIN dbo.UploadBatches b ON b.BatchID=m.BatchID
        JOIN dbo.Cameras c ON c.CameraID=b.CameraID JOIN dbo.Underpasses u ON u.UnderpassID=c.UnderpassID
        WHERE m.MediaID=@MediaID AND ${scope}
          ${user.role === 'road' ? `AND EXISTS (
              SELECT 1 FROM dbo.EventMediaMap map
              JOIN dbo.Events e ON e.EventID=map.EventID AND e.BatchID=m.BatchID AND e.CameraID=b.CameraID
              ${reviewJoin}
              WHERE map.MediaID=m.MediaID AND ${roadEventScope(request, user)})` : ''}`);
    const item = result.recordset[0];
    if (!item) throw new ApiError(404, 'Media not found.');
    const container = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage)
        .getContainerClient(process.env.WILDLIFE_MEDIA_CONTAINER || 'wildlife-media');
    const blobName = blobNameFromUrl(item.BlobUrl, container.containerName);
    if (!blobName) throw new ApiError(500, 'Media record does not contain a valid blob location.');
    const blob = container.getBlobClient(blobName);
    const properties = await blob.getProperties();
    const contentType = properties.contentType || 'application/octet-stream';
    const expiresOn = new Date(Date.now() + 5 * 60 * 1000);
    const url = await blob.generateSasUrl({ permissions: 'r', expiresOn });
    return { url, contentType, expiresAt: expiresOn };
}

function blobNameFromUrl(value, containerName) {
    try {
        const parts = new URL(value).pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const containerIndex = parts.indexOf(containerName);
        return containerIndex >= 0 ? parts.slice(containerIndex + 1).join('/') : null;
    } catch {
        return null;
    }
}

module.exports = { openMedia };
