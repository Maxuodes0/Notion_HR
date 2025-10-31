// sync.js
// يربط "طلبات الاجازة" بجدول "الموظفين" حسب رقم الهوية
// ويعيّن "حالة الطلب" إلى "قيد الانتظار" إذا كانت فاضية

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ========= إعدادات البيئة =========
const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;
const LEAVE_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS;

// أسماء الحقول كما تظهر لديك (مع بدائل شائعة احتياطًا)
const EMP_DB_ID_PROP_CANDIDATES = ["رقم الهويه", "رقم الهوية", "الهويه رقم"];
const LEAVE_DB_ID_PROP_CANDIDATES = ["الهويه رقم", "رقم الهوية", "رقم الهويه"];
const RELATION_PROP_NAME = "اسم الموظف";
const STATUS_PROP_NAME = "حالة الطلب";
const PENDING_STATUS_VALUE = "قيد الانتظار";

// ========= أدوات مساعدة =========
// أرقام عربية -> إنجليزية + إزالة أي رموز غير أرقام
const ARABIC_DIGITS = /[٠-٩]/g;
const AR2EN = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
function normalizeCivilId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(ARABIC_DIGITS, d => AR2EN[d]).replace(/[^\d]/g, "").trim();
  return s || null;
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
        continue;
      }
      if (i < retries - 1) continue;
    }
  }
  throw err;
}

// رجّع أول خاصية موجودة من قائمة مرشحين
function pickPropName(rowProps, candidates) {
  for (const name of candidates) {
    if (rowProps[name]) return name;
  }
  return null;
}

function readCivilIdFromProp(prop) {
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

function buildPendingStatusUpdate(statusPropType, statusPropName) {
  if (statusPropType === "status") {
    return { [statusPropName]: { status: { name: PENDING_STATUS_VALUE } } };
  }
  if (statusPropType === "select") {
    return { [statusPropName]: { select: { name: PENDING_STATUS_VALUE } } };
  }
  return {};
}

// ========= بناء فهرس الموظفين: رقم الهوية -> page_id =========
async function buildEmployeeIndex() {
  const index = {};
  let cursor;

  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: EMPLOYEES_DB_ID,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const row of res.results) {
      const props = row.properties;
      const empIdPropName = pickPropName(props, EMP_DB_ID_PROP_CANDIDATES);
      const civilId = readCivilIdFromProp(props[empIdPropName]);
      if (civilId) index[civilId] = row.id;
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return index;
}

// ========= إصلاح طلبات الإجازة =========
async function fixLeaveRequests(employeeIndex) {
  let cursor;

  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: LEAVE_DB_ID,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const row of res.results) {
      const props = row.properties;

      // أسماء الأعمدة الفعلية في هذا الصف
      const leaveIdPropName = pickPropName(props, LEAVE_DB_ID_PROP_CANDIDATES);
      if (!leaveIdPropName) {
        console.log("⚠️ لا أجد عمود الهوية في أحد الصفوف، أتخطاه:", row.id);
        continue;
      }

      const relationProp = props[RELATION_PROP_NAME];
      const statusProp = props[STATUS_PROP_NAME];

      const alreadyLinked =
        relationProp?.type === "relation" &&
        Array.isArray(relationProp.relation) &&
        relationProp.relation.length > 0;

      const needLink = !alreadyLinked;
      const needPending = isStatusEmpty(statusProp);

      if (!needLink && !needPending) continue;

      const changes = {};

      // 1) اربط الموظف إذا العلاقة فاضية
      if (needLink) {
        const civilId = readCivilIdFromProp(props[leaveIdPropName]);
        if (civilId) {
          const empPage = employeeIndex[civilId];
          if (empPage) {
            changes[RELATION_PROP_NAME] = { relation: [{ id: empPage }] };
          } else {
            console.log("لا يوجد موظف مطابق للهوية:", civilId, "— صفحة الطلب:", row.id);
          }
        } else {
          console.log("رقم الهوية غير موجود/غير صالح في الطلب:", row.id);
        }
      }

      // 2) عيّن الحالة لقيد الانتظار إذا فاضية
      if (needPending) {
        const t = statusProp?.type || "status"; // نفترض status إن لم تتوفر المعلومة
        Object.assign(changes, buildPendingStatusUpdate(t, STATUS_PROP_NAME));
      }

      if (Object.keys(changes).length) {
        await withRetry(() =>
          notion.pages.update({ page_id: row.id, properties: changes })
        );
        console.log(
          `✅ Updated ${row.id}:` +
          (needLink ? " linked;" : "") +
          (needPending ? " status=قيد الانتظار;" : "")
        );
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

// ========= التشغيل =========
async function main() {
  if (!process.env.NOTION_TOKEN || !EMPLOYEES_DB_ID || !LEAVE_DB_ID) {
    throw new Error("Missing NOTION_TOKEN or database IDs env vars.");
  }

  console.log("Building employee index…");
  const employeeIndex = await buildEmployeeIndex();
  console.log("Employees indexed:", Object.keys(employeeIndex).length);

  console.log("Fixing leave requests…");
  await fixLeaveRequests(employeeIndex);

  console.log("Done ✅");
}

main().catch(err => {
  console.error("ERROR:", err?.message || err);
  if (err?.body) console.error(err.body);
  process.exit(1);
});
