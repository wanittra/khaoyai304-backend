const { roadEventScope } = require('./road-event-scope');
const { BlobServiceClient } = require('@azure/storage-blob');
const { underpassScope } = require('./catalog');
const { reviewJoin } = require('./events');
const { ApiError, getConnection, sql, uuid } = require('./common');

const SAS_CLOCK_SKEW_MS = 15 * 60 * 1000;
const DEFAULT_SAS_TTL_SECONDS = 60 * 60;

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska'
};

function sasTtlMs() {
    const seconds = Number(process.env.MEDIA_SAS_TTL_SECONDS);
    return Number.isFinite(seconds) && seconds >= 60
        ? seconds * 1000
        : DEFAULT_SAS_TTL_SECONDS * 1000;
}

function contentTypeFromFileName(fileName) {
    const match = String(fileName || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return (match && MIME_BY_EXT[match[0]]) || 'application/octet-stream';
}

function validTimestamp(value) {
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

async function openMedia(mediaId, user) {
    mediaId = uuid(mediaId, 'mediaId');
    const pool = await getConnection();
    const request = pool.request().input('MediaID', sql.UniqueIdentifier, mediaId);
    const scope = user.role === 'road' ? '1=1' : underpassScope(request, user);
    const result = await request.query(`
        SELECT m.BlobUrl, m.FileName, SYSUTCDATETIME() AS ServerUtcNow
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

    let properties = null;
    try {
        properties = await blob.getProperties();
    } catch (error) {
        if (error?.statusCode === 404 || error?.code === 'BlobNotFound') {
            throw new ApiError(404, 'Media file not found in storage.');
        }
        // If getProperties fails due to local clock skew (403 RequestDateTooSkewed),
        // fall back to SQL Server's SYSUTCDATETIME() and file extension MIME type.
    }

    const detectedType = properties?.contentType && properties.contentType !== 'application/octet-stream'
        ? properties.contentType
        : contentTypeFromFileName(item.FileName);
    const contentType = detectedType || properties?.contentType || 'application/octet-stream';

    const baseTime = validTimestamp(properties?.date)
        ?? validTimestamp(item.ServerUtcNow)
        ?? Date.now();
    const startsOn = new Date(baseTime - SAS_CLOCK_SKEW_MS);
    const expiresOn = new Date(baseTime + sasTtlMs());
    const url = await blob.generateSasUrl({ permissions: 'r', startsOn, expiresOn });
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
