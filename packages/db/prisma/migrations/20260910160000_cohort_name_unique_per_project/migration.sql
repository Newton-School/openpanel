-- Cohort names are unique per project (Newton fork). The API already
-- refuses duplicates case-insensitively; this makes exact duplicates
-- impossible at the database level as well (concurrent creates, scripts).
--
-- Existing exact duplicates within a project, if any, are kept and renamed
-- with a numeric suffix (oldest keeps its name) so the index can be created.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY "projectId", name ORDER BY "createdAt", id) AS rn
  FROM "cohorts"
)
UPDATE "cohorts" c
SET name = c.name || ' (' || r.rn || ')'
FROM ranked r
WHERE c.id = r.id AND r.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "cohorts_projectId_name_key" ON "cohorts"("projectId", "name");
