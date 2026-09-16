-- Fixes Local Sync being broken for every tenant except "default".
--
-- Why: e_assessment_sync_devices rows are created via the normal JWT-
-- authenticated admin routes, so they land in whichever tenant DB the
-- admin's own token points at. But the DEVICE-authenticated routes
-- (GET /local-sync/pull/:id, POST /local-sync/push, GET
-- /local-sync/my-assessments) are called by the local exam server with
-- only an X-Sync-Token header — no JWT, no tenant claim. server.js's
-- global tenant-resolving middleware can only read a tenant off a JWT,
-- so it silently fell back to the "default" DB for these calls
-- regardless of which school actually registered the device. Any
-- non-default tenant's sync device would authenticate against the
-- wrong database and always get "Invalid sync device token".
--
-- Fix: store which tenant a device belongs to, and have
-- authenticateSyncDevice (middleware/syncDeviceAuth.js) resolve the
-- pool from this column (via an X-Tenant-Key header the local exam
-- server now sends) instead of trusting the JWT-based guess.
--
-- This migration is additive and safe to run on a live database.
-- ensureSchema.js applies the same patch automatically on boot for
-- every configured tenant DB, backfilling existing device rows to
-- that tenant's own key — this file is kept for anyone who prefers to
-- run migrations by hand / for the record.

IF NOT EXISTS (
    SELECT * FROM sys.columns
    WHERE Name = N'tenant_key' AND Object_ID = Object_ID(N'e_assessment_sync_devices')
)
BEGIN
    ALTER TABLE e_assessment_sync_devices ADD tenant_key NVARCHAR(50) NOT NULL DEFAULT 'default';
END;

-- If every device row in THIS database actually belongs to a specific
-- tenant other than "default", update the line below (uncomment and
-- fill in the tenant key) and run it once for that tenant's DB. Left
-- commented out because this migration is generic across all tenant
-- databases and shouldn't guess.
-- UPDATE e_assessment_sync_devices SET tenant_key = '<your_tenant_key>' WHERE tenant_key = 'default';
