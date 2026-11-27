import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assessments (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'Draft',
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      duration INTEGER NOT NULL DEFAULT 5,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO assessments (id,title,description,category,status,questions,duration)
    VALUES
      ('QF-001','Personal Growth Baseline','Assess habits, focus and direction.','Growth','Published','[]'::jsonb,8),
      ('QF-002','Leadership Readiness','Explore decision making and ownership.','Leadership','Draft','[]'::jsonb,12)
    ON CONFLICT (id) DO NOTHING
  `);
}

app.get("/api/health", async (_req, res) => {
  try {
    if (pool) await pool.query("SELECT 1");
    res.json({ ok: true, database: Boolean(pool) });
  } catch {
    res.status(503).json({ ok: false, database: false });
  }
});

app.get("/api/assessments", async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not configured" });
  try {
    const result = await pool.query("SELECT id,title,description,category,status,questions,duration FROM assessments ORDER BY updated_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to load assessments" });
  }
});

app.post("/api/assessments", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not configured" });
  const a = req.body || {};
  if (!a.id || !a.title) return res.status(400).json({ error: "id and title are required" });
  try {
    await pool.query(
      "INSERT INTO assessments (id,title,description,category,status,questions,duration) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,category=EXCLUDED.category,status=EXCLUDED.status,questions=EXCLUDED.questions,duration=EXCLUDED.duration,updated_at=NOW()",
      [a.id, a.title, a.description || "", a.category || "General", a.status || "Draft", JSON.stringify(a.questions || []), Number(a.duration || 5)]
    );
    res.status(201).json(a);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to save assessment" });
  }
});

app.put("/api/assessments/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not configured" });
  const a = req.body || {};
  try {
    const result = await pool.query(
      "UPDATE assessments SET title=$2,description=$3,category=$4,status=$5,questions=$6,duration=$7,updated_at=NOW() WHERE id=$1 RETURNING id,title,description,category,status,questions,duration",
      [req.params.id, a.title, a.description || "", a.category || "General", a.status || "Draft", JSON.stringify(a.questions || []), Number(a.duration || 5)]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Assessment not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to update assessment" });
  }
});

app.delete("/api/assessments/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL is not configured" });
  try {
    await pool.query("DELETE FROM assessments WHERE id=$1", [req.params.id]);
    res.status(204).end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to delete assessment" });
  }
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(dirname, "dist", "index.html")));

initDb()
  .then(() => app.listen(PORT, () => console.log("QuizFlow listening on " + PORT)))
  .catch(error => {
    console.error("Database initialization failed", error);
    app.listen(PORT, () => console.log("QuizFlow web server started without DB"));
  });
