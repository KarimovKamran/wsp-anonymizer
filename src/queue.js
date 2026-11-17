'use strict';
// Простая очередь в процессе: задания лежат в SQLite, при рестарте недоделанные возвращаются в очередь.
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { config } = require('./config');
const { processJob } = require('./engine/processor');

const q = {
  next: db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1"),
  start: db.prepare("UPDATE jobs SET status = 'processing', started_at = datetime('now'), progress = 'Старт', model = ? WHERE id = ? AND status = 'queued'"),
  progress: db.prepare('UPDATE jobs SET progress = ? WHERE id = ?'),
  done: db.prepare("UPDATE jobs SET status = 'done', progress = NULL, finished_at = datetime('now'), result_path = ?, result_name = ?, stats = ? WHERE id = ?"),
  fail: db.prepare("UPDATE jobs SET status = 'error', progress = NULL, finished_at = datetime('now'), error = ? WHERE id = ?"),
  clearEntities: db.prepare('DELETE FROM entities WHERE job_id = ?'),
  recover: db.prepare("UPDATE jobs SET status = 'queued', progress = NULL WHERE status = 'processing'"),
  position: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND created_at <= (SELECT created_at FROM jobs WHERE id = ?)"),
};

let running = 0;

function uploadPath(job) {
  return path.join(config.uploadDir, job.id);
}

async function runOne(job) {
  running++;
  const input = uploadPath(job);
  try {
    q.clearEntities.run(job.id); // на случай повторного запуска после сбоя
    const r = await processJob(job, input, (msg) => q.progress.run(msg, job.id));
    q.done.run(r.resultPath, r.resultName, JSON.stringify(r.stats), job.id);
  } catch (e) {
    console.error(`[job ${job.id}]`, e);
    q.clearEntities.run(job.id);
    q.fail.run(String(e.message || e).slice(0, 1000), job.id);
  } finally {
    // Исходник храним только на время обработки
    fs.rmSync(input, { force: true });
    running--;
    setImmediate(pump);
  }
}

function pump() {
  while (running < config.queueConcurrency) {
    const job = q.next.get();
    if (!job) return;
    if (q.start.run(config.llm.enabled ? config.llm.model : 'regex-only', job.id).changes !== 1) continue;
    runOne(job);
  }
}

function init() {
  q.recover.run();
  // Задания без исходника (удалён при сбое) — помечаем ошибкой
  for (const j of db.prepare("SELECT id FROM jobs WHERE status = 'queued'").all()) {
    if (!fs.existsSync(path.join(config.uploadDir, j.id))) q.fail.run('Исходный файл утерян при перезапуске', j.id);
  }
  setInterval(pump, 5000).unref();
  pump();
}

function queuePosition(id) {
  return q.position.get(id).n;
}

module.exports = { init, pump, uploadPath, queuePosition, stats: () => ({ running }) };
