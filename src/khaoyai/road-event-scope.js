const { sql } = require('./common');

const animalDetected = "review.Outcome='animal_detected'";

// The caller supplies e (event), b (batch), c (camera), and review (current review).
function roadEventScope(request, user) {
    request.input('RoadRequester', sql.NVarChar(64), user.id);
    return `(${animalDetected} AND EXISTS (
        SELECT 1 FROM dbo.RoadDataRequestEvents shared
        JOIN dbo.RoadDataRequests road ON road.RequestID=shared.RequestID
        WHERE shared.EventID=e.EventID AND road.RequesterUserId=@RoadRequester
          AND road.Status='shared' AND road.RoundID=b.RoundID AND road.UnderpassID=c.UnderpassID
    ))`;
}

module.exports = { animalDetected, roadEventScope };
