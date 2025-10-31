// sync.js
// يربط طلبات الإجازة بالموظفين حسب رقم الهوية
// ويضبط حالة الطلب = "قيد الانتظار" إذا كانت فاضية

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// IDs من البيئة
const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;
const LEAVE_DB_ID     = process.env.DATABASE_ID_LEAVE_REQUESTS;

// أسماء الأعمدة
const RELATION_PROP_NAME = "اسم الموظف";           // relation داخل "طلبات الإجازة" يشير لجدول الموظفين
const STATUS_PROP_NAME   = "حالة الطلب";           // Status أو Select
const PENDING_VALUE      = "قيد الانتظار";

// مرشّحات أسماء رقم الهوية (عشان اختلاف الصياغة)
const EMP_ID_CANDIDATES   = ["رقم الهويه", "رقم الهوية"];         // في جدول الموظفين
const LEAVE_ID_CANDIDATES = ["الهويه رقم", "رقم الهويه", "رقم الهوية"]; // في جدول طلبات الإجازة

// ===== Helpers =====
const ARABIC_DIGITS = /[٠-٩]/g;
const AR2EN = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };

function normalizeCivilId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(ARABIC_DIGITS, d => AR2EN[d])
    .replace(/[^\d]/g, "")
    .trim();
  return s || null;
}

function pickPropName(props, candidates) {
  for (const name of candidates) if (props[name]) return name;
  return null;
}

function readCivilId(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case "title":        return normalizeCivilId(prop.title?.[0]?.plain_text);
    case "rich_text":    return normalizeCivilId(prop.rich_text?.[0]?.plain_text);
    case "number":       return normalizeCivilId(prop.number);
    case "phone_number": return normalizeCivilId(prop.phone_number);
    case "formula":
      if (prop.formula.type === "string") return normalizeCivilId(prop.formula.string);
      if (prop.formula.type === "number") return normalizeCivilId(prop.formula.number);
      return null;
    case "rollup":
      if (prop.rollup.array?.length) {
        const v = prop.rollup.array[0];
        if (v.type === "title")     return normalizeCivilId(v.title?.[0]?.plain_text);
        if (v.type === "rich_text") return normalizeCivilId(v.rich_text?.[0]?.plain_text);
        if (v.type === "number")    return normalizeCivilId(v.number);
      }
      if (prop.rollup.type === "number") return normalizeCivilId(prop.rollup.number);
      return null;
    default: return null;
  }
}

function isStatusEmpty(prop) {
  if (!prop) return true;
  if (prop.type === "status") return !prop.status;
  if (prop.type === "select") return !prop.select;
  return true;
}

async function withRetry(fn, retries = 3) {
  let err;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      err = e;
      const rate = e?.status === 429 || e?.body?.code === "rate_limited";
      if (rate && i < retries - 1) {
        const wait = Math.min(2000 * (i + 1), 8000);
        await new Promise(r => setTimeout(r, wait));
      } else if (i < retries - 1) {
        continue;
      }
    }
  }
  throw err;
}

// ===== 1) ابنِ فهرس الموظفين: رقم الهوية -> page_id =====
async function buildEmployeeIndex() {
  const index = {};
  let cursor;

  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: EMPLOYEES_DB_ID,
        start_cursor: cursor,
        page_size: 100
      })
    );

    for (const row of res.results) {
      const empProps = row.properties;
      const empIdName = pickPropName(empProps, EMP_ID_CANDIDATES) || Object.keys(empProps)[0];
      const civil = readCivilId(empProps[empIdName]);
      if (civil) index[civil] = row.id;
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return index;
}

// ===== 2) مرّ على طلبات الإجازة واربط + اضبط الحالة =====
async function syncLeaveRequests(employeeIndex) {
  let cursor;

  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: LEAVE_DB_ID,
        start_cursor: cursor,
        page_size: 100
      })
    );

    for (const row of res.results) {
      const props = row.properties;

      // أسماء الحقول الفعلية في هذا الصف
      const leaveIdName = pickPropName(props, LEAVE_ID_CANDIDATES);
      if (!leaveIdName) {
        console.log("⚠️ ما لقيت عمود رقم الهوية في صف:", row.id);
        continue;
      }

      const rel = props[RELATION_PROP_NAME];
      const stat = props[STATUS_PROP_NAME];

      const alreadyLinked = rel?.type === "relation" && rel.relation?.length > 0;
      const needPending   = isStatusEmpty(stat);

      // نقرأ رقم الهوية من الطلب
      const civil = readCivilId(props[leaveIdName]);
      if (!civil) {
        // حتى لو ما فيه هوية، لو الحالة فاضية نحط قيد الانتظار فقط
        if (needPending) {
          await withRetry(() =>
            notion.pages.update({
              page_id: row.id,
              properties: { [STATUS_PROP_NAME]: buildStatusSet(stat, PENDING_VALUE) }
            })
          );
          console.log(`🟡 Pending only: ${row.id}`);
        }
        continue;
      }

      const empPageId = employeeIndex[civil];

      const updateProps = {};

      // اربط إذا غير مربوط ويوجد موظف مطابق
      if (!alreadyLinked && empPageId) {
        updateProps[RELATION_PROP_NAME] = { relation: [{ id: empPageId }] };
      }

      // عيّن الحالة إذا فاضية
      if (needPending) {
        updateProps[STATUS_PROP_NAME] = buildStatusSet(stat, PENDING_VALUE);
      }

      if (Object.keys(updateProps).length) {
        await withRetry(() =>
          notion.pages.update({ page_id: row.id, properties: updateProps })
        );
        console.log(
          `✅ Updated ${row.id}` +
          (!alreadyLinked && empPageId ? " (linked)" : "") +
          (needPending ? " (pending)" : "")
        );
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

// يبني قيمة التعيين للـ Status/Select حسب نوع الحقل الحالي
function buildStatusSet(currentProp, name) {
  const type = currentProp?.type || "status";
  if (type === "status") return { status: { name } };
  if (type === "select") return { select: { name } };
  // fallback لو كان النوع غير معروف
  return { status: { name } };
}

// ===== Run =====
async function main() {
  if (!process.env.NOTION_TOKEN || !EMPLOYEES_DB_ID || !LEAVE_DB_ID) {
    throw new Error("Missing NOTION_TOKEN or database IDs.");
  }

  console.log("Building employee index…");
  const idx = await buildEmployeeIndex();
  console.log("Employees indexed:", Object.keys(idx).length);

  console.log("Syncing leave requests…");
  await syncLeaveRequests(idx);

  console.log("Done ✅");
}

main().catch(err => {
  console.error("ERROR:", err?.message || err);
  if (err?.body) console.error(err.body);
  process.exit(1);
});
