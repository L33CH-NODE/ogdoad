-- Project rooms: for each project Ogdoad opened a room on, which of the engine's tasks is the room's own
-- thread (where the operator and the hires talk; each part of the job is a sub-task of it).
CREATE TABLE rooms (
  project_id TEXT PRIMARY KEY,
  thread_issue_id TEXT NOT NULL,
  opened_at TEXT NOT NULL
);
