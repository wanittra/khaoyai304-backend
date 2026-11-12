SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.Underpasses', 'U') IS NULL
CREATE TABLE dbo.Underpasses (
    UnderpassID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Underpasses PRIMARY KEY,
    UnderpassCode nvarchar(20) NOT NULL CONSTRAINT UQ_Underpasses_Code UNIQUE,
    UnderpassName nvarchar(200) NOT NULL,
    Latitude decimal(9,6) NULL,
    Longitude decimal(9,6) NULL
);

IF OBJECT_ID('dbo.Cameras', 'U') IS NULL
CREATE TABLE dbo.Cameras (
    CameraID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Cameras PRIMARY KEY,
    UnderpassID int NOT NULL CONSTRAINT FK_Cameras_Underpass FOREIGN KEY REFERENCES dbo.Underpasses(UnderpassID),
    CameraCode nvarchar(50) NOT NULL CONSTRAINT UQ_Cameras_Code UNIQUE,
    CameraName nvarchar(200) NOT NULL,
    CameraType varchar(20) NOT NULL,
    Latitude decimal(9,6) NULL,
    Longitude decimal(9,6) NULL
);

IF OBJECT_ID('dbo.SurveyRounds', 'U') IS NULL
CREATE TABLE dbo.SurveyRounds (
    RoundID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_SurveyRounds PRIMARY KEY,
    RoundName nvarchar(200) NOT NULL,
    StartDate date NOT NULL,
    EndDate date NOT NULL
);

IF OBJECT_ID('dbo.AppUsers', 'U') IS NULL
CREATE TABLE dbo.AppUsers (
    UserId nvarchar(64) NOT NULL CONSTRAINT PK_AppUsers PRIMARY KEY,
    Username nvarchar(100) NOT NULL CONSTRAINT UQ_AppUsers_Username UNIQUE,
    DisplayName nvarchar(200) NOT NULL,
    RoleCode nvarchar(30) NOT NULL,
    AllowedUnderpasses nvarchar(max) NOT NULL,
    PasswordSalt binary(16) NOT NULL,
    PasswordHash binary(32) NOT NULL,
    PasswordIterations int NOT NULL,
    IsActive bit NOT NULL CONSTRAINT DF_AppUsers_IsActive DEFAULT (1)
);

IF OBJECT_ID('dbo.AppSessions', 'U') IS NULL
CREATE TABLE dbo.AppSessions (
    SessionHash binary(32) NOT NULL CONSTRAINT PK_AppSessions PRIMARY KEY,
    UserId nvarchar(64) NOT NULL CONSTRAINT FK_AppSessions_User FOREIGN KEY REFERENCES dbo.AppUsers(UserId),
    ExpiresAt datetime2 NOT NULL
);

IF OBJECT_ID('dbo.UploadBatches', 'U') IS NULL
CREATE TABLE dbo.UploadBatches (
    BatchID uniqueidentifier NOT NULL CONSTRAINT PK_UploadBatches PRIMARY KEY,
    RoundID int NOT NULL CONSTRAINT FK_UploadBatches_Round FOREIGN KEY REFERENCES dbo.SurveyRounds(RoundID),
    CameraID int NOT NULL CONSTRAINT FK_UploadBatches_Camera FOREIGN KEY REFERENCES dbo.Cameras(CameraID),
    FieldTeamUser nvarchar(100) NOT NULL,
    UploadedAt datetime2 NOT NULL CONSTRAINT DF_UploadBatches_UploadedAt DEFAULT SYSUTCDATETIME()
);

IF OBJECT_ID('dbo.AppBatchFailures', 'U') IS NULL
CREATE TABLE dbo.AppBatchFailures (
    BatchID uniqueidentifier NOT NULL CONSTRAINT PK_AppBatchFailures PRIMARY KEY
        CONSTRAINT FK_AppBatchFailures_Batch FOREIGN KEY REFERENCES dbo.UploadBatches(BatchID),
    FailedAt datetime2 NOT NULL
);

IF OBJECT_ID('dbo.MediaFiles', 'U') IS NULL
CREATE TABLE dbo.MediaFiles (
    MediaID uniqueidentifier NOT NULL CONSTRAINT PK_MediaFiles PRIMARY KEY DEFAULT NEWID(),
    BatchID uniqueidentifier NOT NULL CONSTRAINT FK_MediaFiles_Batch FOREIGN KEY REFERENCES dbo.UploadBatches(BatchID),
    BlobUrl nvarchar(max) NOT NULL,
    FileName nvarchar(500) NOT NULL,
    CapturedAt datetime2 NOT NULL
);

IF OBJECT_ID('dbo.Events', 'U') IS NULL
CREATE TABLE dbo.Events (
    EventID uniqueidentifier NOT NULL CONSTRAINT PK_Events PRIMARY KEY DEFAULT NEWID(),
    BatchID uniqueidentifier NOT NULL CONSTRAINT FK_Events_Batch FOREIGN KEY REFERENCES dbo.UploadBatches(BatchID),
    CameraID int NOT NULL CONSTRAINT FK_Events_Camera FOREIGN KEY REFERENCES dbo.Cameras(CameraID),
    StartTime datetime2 NOT NULL,
    EndTime datetime2 NOT NULL,
    MediaCount int NOT NULL
);

IF OBJECT_ID('dbo.EventMediaMap', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EventMediaMap (
        EventID uniqueidentifier NOT NULL CONSTRAINT FK_EventMediaMap_Event FOREIGN KEY REFERENCES dbo.Events(EventID),
        MediaID uniqueidentifier NOT NULL CONSTRAINT FK_EventMediaMap_Media FOREIGN KEY REFERENCES dbo.MediaFiles(MediaID),
        CONSTRAINT PK_EventMediaMap PRIMARY KEY (EventID, MediaID)
    );
    CREATE UNIQUE INDEX UX_EventMediaMap_MediaID ON dbo.EventMediaMap(MediaID);
END;

IF OBJECT_ID('dbo.AppCameraCoverage', 'U') IS NULL
CREATE TABLE dbo.AppCameraCoverage (
    RoundID int NOT NULL CONSTRAINT FK_AppCameraCoverage_Round FOREIGN KEY REFERENCES dbo.SurveyRounds(RoundID),
    CameraID int NOT NULL CONSTRAINT FK_AppCameraCoverage_Camera FOREIGN KEY REFERENCES dbo.Cameras(CameraID),
    SurveyDate date NOT NULL,
    Status varchar(20) NOT NULL CONSTRAINT CK_AppCameraCoverage_Status CHECK (Status IN ('active', 'offline', 'unknown')),
    Notes nvarchar(1000) NULL,
    RecordedBy nvarchar(64) NOT NULL CONSTRAINT FK_AppCameraCoverage_User FOREIGN KEY REFERENCES dbo.AppUsers(UserId),
    UpdatedAt datetime2 NOT NULL,
    CONSTRAINT PK_AppCameraCoverage PRIMARY KEY (RoundID, CameraID, SurveyDate)
);

IF OBJECT_ID('dbo.AppEventReviews', 'U') IS NULL
CREATE TABLE dbo.AppEventReviews (
    EventID uniqueidentifier NOT NULL CONSTRAINT PK_AppEventReviews PRIMARY KEY
        CONSTRAINT FK_AppEventReviews_Event FOREIGN KEY REFERENCES dbo.Events(EventID),
    ReviewerUserId nvarchar(64) NOT NULL CONSTRAINT FK_AppEventReviews_User FOREIGN KEY REFERENCES dbo.AppUsers(UserId),
    Outcome varchar(20) NOT NULL CONSTRAINT CK_AppEventReviews_Outcome CHECK (Outcome IN ('animal_detected', 'no_animal', 'uncertain')),
    Species nvarchar(200) NULL,
    Behavior nvarchar(500) NULL,
    Notes nvarchar(1000) NULL,
    ReviewedAt datetime2 NOT NULL,
    ValidFrom datetime2 GENERATED ALWAYS AS ROW START NOT NULL,
    ValidTo datetime2 GENERATED ALWAYS AS ROW END NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)
)
WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.AppEventReviewsHistory));

IF OBJECT_ID('dbo.RoadDataRequests', 'U') IS NULL
CREATE TABLE dbo.RoadDataRequests (
    RequestID uniqueidentifier NOT NULL CONSTRAINT PK_RoadDataRequests PRIMARY KEY DEFAULT NEWID(),
    RequesterUserId nvarchar(64) NOT NULL CONSTRAINT FK_RoadDataRequests_User FOREIGN KEY REFERENCES dbo.AppUsers(UserId),
    RoundID int NOT NULL CONSTRAINT FK_RoadDataRequests_Round FOREIGN KEY REFERENCES dbo.SurveyRounds(RoundID),
    UnderpassID int NOT NULL CONSTRAINT FK_RoadDataRequests_Underpass FOREIGN KEY REFERENCES dbo.Underpasses(UnderpassID),
    Reason nvarchar(1000) NOT NULL,
    Status varchar(20) NOT NULL CONSTRAINT DF_RoadDataRequests_Status DEFAULT ('pending'),
    RequestedAt datetime2 NOT NULL CONSTRAINT DF_RoadDataRequests_RequestedAt DEFAULT SYSUTCDATETIME()
);

IF OBJECT_ID('dbo.RoadDataRequestEvents', 'U') IS NULL
CREATE TABLE dbo.RoadDataRequestEvents (
    RequestID uniqueidentifier NOT NULL CONSTRAINT FK_RoadDataRequestEvents_Request FOREIGN KEY REFERENCES dbo.RoadDataRequests(RequestID),
    EventID uniqueidentifier NOT NULL CONSTRAINT FK_RoadDataRequestEvents_Event FOREIGN KEY REFERENCES dbo.Events(EventID),
    SharedByUserId nvarchar(64) NOT NULL CONSTRAINT FK_RoadDataRequestEvents_User FOREIGN KEY REFERENCES dbo.AppUsers(UserId),
    SharedAt datetime2 NOT NULL CONSTRAINT DF_RoadDataRequestEvents_SharedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_RoadDataRequestEvents PRIMARY KEY (RequestID, EventID)
);

COMMIT;
