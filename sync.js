// link-leaves.js
// سكربت لربط طلبات الإجازة بجدول الموظفين وتعيين حالة الطلب لقيد الانتظار عند الحاجة

import { Client } from "@notionhq/client";

// ====== الإعدادات العامة ======
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// IDs من Secrets أو متغيرات البيئة
const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;
const LEAVE_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS;

// أسماء الأعمدة في Notion (تأكد تطابقها 100%)
const EMPLOYEE_ID_PROP = "رقم الهوية"; // موجود في الجدولين
const EMPLOYEE_REL_PROP = "اسم الموظف"; // عمود Relation داخل جدول الإجازات
const STATUS_PROP = "حالة الطلب";       // Status أو Select داخل جدول الإجازات
const PENDING_STATUS_VALUE = "قيد الانتظار";

// ====== أدوات مساعدة ======
// تحويل الأرقام العربية/الهندية إلى إنجليزية
const ARABIC_DIGITS = /[٠-٩]/g;
const ARABIC_TO_LATIN = {
  "٠":"0","١":"1","٢":"2","٣":"3","٤":"4",
  "٥":"5","٦":"6","٧":"7","٨":"8","٩":"9"
};

// توحيد رقم الهوية كنص أرقام فقط
function normalizeCivilId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value)
    .replace(ARABIC_DIGITS, d => ARABIC_TO_LATIN[d])
    .replace(/[^\d]/g, "")
    .trim();
  return s.length ? s : null;
}

// محاولة مع إعادة المحاولة عند rate limit
async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const isRate = e?.status === 429 || e?.body?.code === "rate_limited";
      if (isRate && i < retries - 1) {
        const wait = Math.min(2000 * (i + 1), 8000);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (i < retries - 1) continue;
    }
  }
  throw lastErr;
}

// قراءة رقم الهوية من أي نوع شائع في Notion
function getCivilIdFromProperty(prop) {
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
        if (v.type === "title")      return normalizeCivilId(v.title?.[0]?.plain_text);
        if (v.type === "rich_text")  return normalizeCivilId(v.rich_text?.[0]?.plain_text);
        if (v.type === "number")     return normalizeCivilId(v.number);
      }
      if (prop.rollup.type === "number") return normalizeCivilId(prop.rollup.number);
      return null;
    default: return null;
  }
}

// هل حالة الطلب فاضية؟
function isStatusEmpty(prop) {
  if (!prop) return true;
  if (prop.type === "status") return !prop.status;
  if (prop.type === "select") return !prop.select;
  return true;
}

// إعداد تحديث الحالة لقيمة "قيد الانتظار" حسب نوع الحقل
function buildPendingStatusUpdate(statusProp) {
  if (!statusProp) return {};
  if (statusProp.type === "status") {
    return { [STATUS_PROP]: { status: { name: PENDING_STATUS_VALUE } } };
  }
  if (statusProp.type === "select") {
    return { [STATUS_PROP]: { select: { name: PENDING_STATUS_VALUE } } };
  }
  return {};
}

// ====== منطق العمل ======
// ابنِ فهرس الموظفين: رقم الهوية -> page_id
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
      const idProp = row.properties[EMPLOYEE_ID_PROP];
      const civilId = getCivilIdFromProperty(idProp);
      if (civilId) index[civilId] = row.id;
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return index;
}

// أصلح طلبات الإجازة: اربط الموظف وعيّن الحالة عند الحاجة
async function fixLeaveRequests(employeeIndex) {
  let cursor;

  // فلتر: (العلاقة فاضية) OR (الحالة فاضية) + وجود رقم هوية
  const baseFilter = {
    and: [
      {
        or: [
          { property: EMPLOYEE_REL_PROP, relation: { is_empty: true } },
          { property: STATUS_PROP, status: { is_empty: true } },
          { property: STATUS_PROP, select: { is_empty: true } }
        ]
      },
      {
        or: [
          { property: EMPLOYEE_ID_PROP, rich_text: { is_not_empty: true } },
          { property: EMPLOYEE_ID_PROP, number: { is_not_empty: true } },
          { property: EMPLOYEE_ID_PROP, phone_number: { is_not_empty: true } },
          { property: EMPLOYEE_ID_PROP, formula: { string: { is_not_empty: true } } },
          { property: EMPLOYEE_ID_PROP, formula: { number: { is_not_empty: true } } }
        ]
      }
    ]
  };

  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: LEAVE_DB_ID,
        start_cursor: cursor,
        page_size: 100,
        filter: baseFilter
      })
    );

    for (const row of res.results) {
      const leavePageId = row.id;

      // خصائص سنستخدمها
      const relProp = row.properties[EMPLOYEE_REL_PROP];
      const statusProp = row.properties[STATUS_PROP];
      const idProp = row.properties[EMPLOYEE_ID_PROP];

      const alreadyLinked =
        relProp?.type === "relation" && Array.isArray(relProp.relation) && relProp.relation.length > 0;

      const needLink = !alreadyLinked;
      const needPending = isStatusEmpty(statusProp);

      // لا شيء لعمله
      if (!needLink && !needPending) continue;

      // جهّز التحديث
      const propertiesUpdate = {};

      // 1) اربط الطلب بموظف لو العلاقة فاضية
      if (needLink) {
        const civilId = getCivilIdFromProperty(idProp);
        if (civilId) {
          const employeePageId = employeeIndex[civilId];
          if (employeePageId) {
            propertiesUpdate[EMPLOYEE_REL_PROP] = { relation: [{ id: employeePageId }] };
          } else {
            console.log("No employee match for", civilId, "in leave", leavePageId);
          }
        } else {
          console.log("Leave request", leavePageId, "has no civilId");
        }
      }

      // 2) عيّن الحالة لقيد الانتظار إذا فاضية
      if (needPending) {
        Object.assign(propertiesUpdate, buildPendingStatusUpdate(statusProp));
      }

      if (Object.keys(propertiesUpdate).length) {
        await withRetry(() =>
          notion.pages.update({
            page_id: leavePageId,
            properties: propertiesUpdate
          })
        );
        console.log(
          `Updated ${leavePageId}:` +
          (needLink ? " linked relation;" : "") +
          (needPending ? " set status=قيد الانتظار;" : "")
        );
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

// ====== التشغيل ======
async function main() {
  if (!process.env.NOTION_TOKEN || !EMPLOYEES_DB_ID || !LEAVE_DB_ID) {
    throw new Error("Missing NOTION_TOKEN or database IDs env vars.");
  }

  console.log("Building employee index...");
  const employeeIndex = await buildEmployeeIndex();
  console.log("Employees indexed:", Object.keys(employeeIndex).length);

  console.log("Fixing leave requests...");
  await fixLeaveRequests(employeeIndex);

  console.log("Done ✅");
}

main().catch(err => {
  console.error("ERROR:", err?.message || err);
  if (err?.body) console.error(err.body);
  process.exit(1);
});
