const { app } = require('@azure/functions');
const auth = require('../khaoyai/auth');
const catalog = require('../khaoyai/catalog');
const coverage = require('../khaoyai/coverage');
const events = require('../khaoyai/events');
const media = require('../khaoyai/media');
const report = require('../khaoyai/report');
const roadData = require('../khaoyai/road-data');
const { handleError, json, queryValue, readJson } = require('../khaoyai/common');

const evidenceRoles = ['reviewer', 'researcher', 'road', 'admin'];

function endpoint(name, options, handler) {
    app.http(name, {
        authLevel: 'anonymous',
        ...options,
        handler: async (request, context) => {
            try { return await handler(request, context); }
            catch (error) { return handleError(error, context); }
        }
    });
}

endpoint('authLogin', { methods: ['POST'], route: 'auth/login' }, async request => {
    const body = await readJson(request);
    const result = await auth.login(body.username, body.password);
    return json(200, { user: result.user }, { 'set-cookie': auth.sessionCookie(result.token) });
});

endpoint('authLogout', { methods: ['POST'], route: 'auth/logout' }, async request => {
    await auth.logout(request);
    return json(204, undefined, { 'set-cookie': auth.sessionCookie('', 0) });
});

endpoint('authMe', { methods: ['GET'], route: 'auth/me' }, async request => {
    const user = await auth.getSession(request);
    const { id, username, displayName, role } = user;
    return json(200, { user: { id, username, displayName, role } });
});

endpoint('catalogCameras', { methods: ['GET'], route: 'catalog/cameras' }, async request => {
    const user = await auth.getSession(request);
    return json(200, { cameras: await catalog.listCameras(user) });
});

endpoint('catalogRounds', { methods: ['GET'], route: 'catalog/rounds' }, async request => {
    await auth.getSession(request);
    return json(200, { rounds: await catalog.listRounds() });
});

endpoint('coverageGet', { methods: ['GET'], route: 'coverage' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['field_team', 'admin']);
    const record = await coverage.getCoverage({
        roundId: queryValue(request, 'roundId'), cameraId: queryValue(request, 'cameraId'),
        date: queryValue(request, 'date')
    }, user);
    return json(200, { coverage: record });
});

endpoint('coverageSave', { methods: ['PUT'], route: 'coverage' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['field_team', 'admin']);
    return json(200, { coverage: await coverage.saveCoverage(await readJson(request), user) });
});

endpoint('batchStatus', { methods: ['GET'], route: 'batches/{batchId}' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['field_team', 'reviewer', 'researcher', 'admin']);
    return json(200, await events.batchStatus(request.params.batchId, user));
});

endpoint('eventList', { methods: ['GET'], route: 'events' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, evidenceRoles);
    return json(200, { events: await events.listEvents({
        cameraId: queryValue(request, 'cameraId'), roundId: queryValue(request, 'roundId'),
        reviewStatus: queryValue(request, 'reviewStatus')
    }, user) });
});

endpoint('eventDetail', { methods: ['GET'], route: 'events/{eventId}' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, evidenceRoles);
    return json(200, await events.getEvent(request.params.eventId, user));
});

endpoint('eventReviewHistory', { methods: ['GET'], route: 'events/{eventId}/review-history' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['reviewer', 'researcher', 'admin']);
    return json(200, { versions: await events.reviewHistory(request.params.eventId, user) });
});


endpoint('eventReview', { methods: ['PATCH'], route: 'events/{eventId}' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['reviewer', 'researcher', 'admin']);
    return json(200, await events.reviewEvent(request.params.eventId, await readJson(request), user));
});

endpoint('mediaOpen', { methods: ['GET'], route: 'media/{mediaId}' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, evidenceRoles);
    return json(200, await media.openMedia(request.params.mediaId, user));
});

endpoint('reportSummary', { methods: ['GET'], route: 'reports/summary' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, evidenceRoles);
    return json(200, { rows: await report.summary(queryValue(request, 'roundId'), user) });
});

endpoint('roadDataUnderpasses', { methods: ['GET'], route: 'road-data-request-underpasses' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['road']);
    return json(200, { underpasses: await roadData.listUnderpasses() });
});

endpoint('roadDataRequestList', { methods: ['GET'], route: 'road-data-requests' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['road', 'researcher']);
    return json(200, { requests: await roadData.listRequests(user) });
});

endpoint('roadDataRequestCreate', { methods: ['POST'], route: 'road-data-requests' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['road']);
    return json(201, await roadData.createRequest(await readJson(request), user));
});

endpoint('roadDataRequestDetail', { methods: ['GET'], route: 'road-data-requests/{requestId}' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['road', 'researcher']);
    return json(200, await roadData.getRequest(request.params.requestId, user));
});

endpoint('roadDataRequestShare', { methods: ['POST'], route: 'road-data-requests/{requestId}/share' }, async request => {
    const user = await auth.getSession(request);
    auth.requireRole(user, ['researcher']);
    return json(200, await roadData.shareRequest(request.params.requestId, await readJson(request), user));
});

