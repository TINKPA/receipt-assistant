-- #128: file_path was persisted as an absolute path tied to whichever
-- environment ran the ingest (host: /Users/.../data/uploads/<sha>.eml,
-- container: /data/uploads/<sha>.jpg). Rewrite to the uploads-relative
-- form so the same row resolves in both runtimes; the app now resolves
-- against UPLOAD_DIR at read time (documents.service.ts::resolveUploadPath).
-- The guarded WHERE leaves any row not under an uploads/ dir untouched —
-- those keep working via the resolver's isAbsolute fallback.
UPDATE documents
   SET file_path = regexp_replace(file_path, '^.*/uploads/', '')
 WHERE file_path LIKE '/%'
   AND file_path LIKE '%/uploads/%';
--> statement-breakpoint
UPDATE ingests
   SET file_path = regexp_replace(file_path, '^.*/uploads/', '')
 WHERE file_path LIKE '/%'
   AND file_path LIKE '%/uploads/%';
