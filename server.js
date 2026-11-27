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

app.get("/api/stats", async (_req,res) => {
 if(!pool)return res.status(503).json({error:"Database unavailable"});
 try{
  const subs=await pool.query("SELECT COUNT(*)::int AS total FROM quizflow_subscribers");
  const dyn=await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed FROM quizflow_dynamic_attempts");
  const base=await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed FROM quizflow_attempts");
  const total=Number(dyn.rows[0].total)+Number(base.rows[0].total), completed=Number(dyn.rows[0].completed)+Number(base.rows[0].completed);
  res.json({subscribers:subs.rows[0].total,attempts:total,completed,completion:total?Math.round(completed/total*100):0});
 }catch(err){console.error("Stats error",err);res.status(503).json({error:"Quiz analytics tables are not ready yet"});}
});
app.get("/api/subscribers", async (_req,res) => {
 if(!pool)return res.status(503).json({error:"Database unavailable"});
 try{
  const q=await pool.query(`SELECT s.telegram_id,s.first_name,s.username,s.created_at,s.last_seen,
   COUNT(d.id)::int AS attempts,COUNT(d.id) FILTER (WHERE d.completed_at IS NOT NULL)::int AS completed,
   MAX(d.started_at) AS last_attempt
   FROM quizflow_subscribers s LEFT JOIN quizflow_dynamic_attempts d ON d.telegram_id=s.telegram_id
   GROUP BY s.telegram_id ORDER BY s.last_seen DESC`);
  res.json(q.rows);
 }catch(e){console.error(e);res.status(500).json({error:"Unable to load subscribers"});}
});
app.get("/api/subscribers/:id", async (req,res) => {
 if(!pool)return res.status(503).json({error:"Database unavailable"});
 try{
  const id=req.params.id;
  const subscriber=await pool.query("SELECT telegram_id,first_name,username,created_at,last_seen FROM quizflow_subscribers WHERE telegram_id=$1",[id]);
  if(!subscriber.rowCount)return res.status(404).json({error:"Subscriber not found"});
  const attempts=await pool.query(`SELECT id,assessment_id,assessment_title,started_at,completed_at,answers,current_question,a.questions
   FROM quizflow_dynamic_attempts d LEFT JOIN assessments a ON a.id=d.assessment_id
   WHERE d.telegram_id=$1 ORDER BY d.started_at DESC`,[id]);
  const results=[];
  for(const a of attempts.rows){
   const answers=await pool.query("SELECT question_index,answer,answered_at FROM quizflow_dynamic_answers WHERE attempt_id=$1 ORDER BY question_index",[a.id]);
   const qs=a.questions||[],ans=answers.rows.map(r=>({question_index:r.question_index,question:qs[r.question_index]?.prompt||qs[r.question_index]?.text||("Question "+(r.question_index+1)),type:qs[r.question_index]?.type||"unknown",options:qs[r.question_index]?.options||[],correct_answer:qs[r.question_index]?.correctAnswer??qs[r.question_index]?.correct_answer??qs[r.question_index]?.answer_key??null,answer:r.answer,answered_at:r.answered_at}));
   let correct=0,wrong=0,scored=0;
   const norm=v=>String(v??"").trim().toLowerCase();
   for(const r of ans){if(r.correct_answer==null||r.correct_answer==="")continue;let user=r.answer;if(typeof user==="string"){try{user=JSON.parse(user)}catch{}}
    const isMulti=String(r.type).toLowerCase().includes("multi"),key=r.correct_answer,eq=isMulti&&Array.isArray(user)&&Array.isArray(key)?user.map(norm).sort().join("|")===key.map(norm).sort().join("|"):norm(user)===norm(key);scored++;if(eq)correct++;else wrong++;
   }
   results.push({id:a.id,title:a.assessment_title,started_at:a.started_at,completed_at:a.completed_at,answered:ans.length,total:qs.length,correct,wrong,scored,percent:scored?Math.round(correct/scored*100):null,answers:ans});
  }
  res.json({subscriber:subscriber.rows[0],attempts:results});
 }catch(e){console.error(e);res.status(500).json({error:"Unable to load subscriber details"});}
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
