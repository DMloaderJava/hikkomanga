/**
 * Диагностика потока анонимных заявок (ТЗ-3): pending по типам, зависшие
 * (>14 дней), топ-10 IP-хэшей, rejected/spam без причины.
 *
 *   npm run check:submissions
 *
 * Два режима:
 *  • SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY в env → живая база (REST);
 *  • без них — demo: хранилище пустое, «чистая база», exit 0
 *    (санбокс/CI без доступа к Supabase).
 *
 * Exit-коды: 0 — чисто/демо; 1 — аномалии (rejected/spam без причины,
 * new_title pending без ip_hash или отметки капчи).
 */
import { createHash } from 'node:crypto';

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const problems = [];
const warnings = [];

function printReport(rows) {
  const pending = rows.filter((r) => r.status === 'pending');
  const resolved = rows.filter((r) => r.status !== 'pending');

  // 1. Pending по типам
  console.log('── Pending по типам ──');
  const byType = {};
  for (const r of pending) byType[r.type] = (byType[r.type] ?? 0) + 1;
  if (pending.length === 0) console.log('  (пусто)');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(14)} ${count}`);
  }

  // 2. Зависшие: pending старше 14 дней
  const stale = pending.filter(
    (r) => Date.now() - new Date(r.created_at).getTime() > 14 * 24 * 3600 * 1000
  );
  console.log(`\n── Pending старше 14 дней: ${stale.length} ──`);
  for (const r of stale.slice(0, 10)) {
    console.log(`  ${r.created_at}  ${r.type}  ${(r.payload?.original_title ?? r.target_name ?? r.id).toString().slice(0, 60)}`);
  }
  if (stale.length > 10) console.log(`  … и ещё ${stale.length - 10}`);
  if (stale.length > 0) {
    warnings.push(`${stale.length} заявок висят без решения >14 дней — разберите инбокс /admin/requests`);
  }

  // 3. Топ-10 ip_hash по всем заявкам
  console.log('\n── Топ-10 ip_hash (заявки всего) ──');
  const byIp = {};
  for (const r of rows) {
    if (!r.ip_hash) continue;
    byIp[r.ip_hash] = (byIp[r.ip_hash] ?? 0) + 1;
  }
  const top = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length === 0) console.log('  (нет заявок с ip_hash)');
  for (const [hash, count] of top) {
    const pendingForIp = rows.filter((r) => r.ip_hash === hash && r.status === 'pending').length;
    console.log(`  ${hash.slice(0, 16)}…  всего ${String(count).padStart(3)}  pending ${pendingForIp}`);
  }
  const flood = top.filter(([, c]) => c >= 50);
  if (flood.length > 0) {
    warnings.push(
      `${flood.length} IP-хэшей с ≥50 заявками — похоже на спам-волну: используйте «Спам-волна» в инбоксе`
    );
  }

  // 4. Аномалии: rejected/spam без причины; new_title pending без аудита
  const noReason = resolved.filter(
    (r) => (r.status === 'rejected' || r.status === 'spam') && !r.reject_reason
  );
  if (noReason.length > 0) {
    problems.push(`${noReason.length} отклонённых/спам-заявок без причины (reject_reason) — заявитель не знает, что исправить`);
  }
  const noAudit = pending.filter(
    (r) => r.type === 'new_title' && (!r.ip_hash || r.turnstile_ok !== true)
  );
  if (noAudit.length > 0) {
    problems.push(
      `${noAudit.length} new_title pending без ip_hash/turnstile_ok — вставлены мимо edge-функции (проверьте RLS и деплой submit-title)`
    );
  }
}

let rows = [];
if (SUPABASE_URL && SERVICE_KEY) {
  process.stdout.write('Запрос к живой базе…\n');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admin_requests?select=id,type,status,created_at,resolved_at,reject_reason,ip_hash,turnstile_ok,conflict,payload&order=created_at.desc&limit=1000`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    console.error(`REST-запрос не удался: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  rows = await res.json();
  console.log(`Заявок в выборке (последние 1000): ${rows.length}\n`);
} else {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы — demo-режим.\n');
}

printReport(rows);

if (warnings.length > 0) {
  console.log('\nПредупреждения:');
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (problems.length > 0) {
  console.log('\nАномалии:');
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}

console.log('\nАномалий нет — CLEAN.');
