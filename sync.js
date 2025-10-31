// sync.js
// يربط طلبات الإجازة بجدول الموظفين + يعيّن "قيد الانتظار" إذا الحالة فاضية
// ويكتشف اسم عمود الـRelation تلقائيًا لتفادي أخطاء اختلاف الأسماء

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ==== بيئة التشغيل ====
const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;
const LEAVE_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS;

// أسماء الحقول "المفضلة" (إن وجدت)، لكن سنحاول اكتشافها تلقائيًا لو مفقودة
const PREFERRED_EMPLOYEE_ID_PROP = "رقم الهوية";   // في الجدولين
const PREFERRED_STATUS_PROP = "حالة الطلب";        // في الإجازات
const PENDING_STATUS_VALUE = "قيد الانتظار";

// ==== أدوات مساعدة ====
// تحويل أرقام عربية->إنجليزية وتوحيد رقم الهوية
const ARABIC_DIGITS = /[٠-٩]/g;
const ARABIC_TO_LATIN = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };

function normalizeCivilId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value)
    .replace(ARABIC_DIGITS, (d) => ARABIC_TO_LATIN[d])
    .replace(/[^\d]/g, "")
    .trim();
  return s.length ? s : null;
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

function buildPendingStatusUpdate(statusProp) {
  if (!statusProp) return {};
  if (statusProp.type === "status") {
    return { [statusProp.name]: { status: { name: PENDING_STATUS_VALUE } } };
  }
  if (statusProp.type === "select") {
    return { [statusProp.name]: { select: { name: PENDING_STATUS_VALUE } } };
  }
  return {};
}

// ==== اكتشاف أسماء الأعمدة تلقائيًا ====
// يرجع أسماء الحقول الفعلية في قاعدة الإجازات: relation -> employees, status, employeeId
async function detectLeaveSchema() {
  const leaveDb = await withRetry(() => notion.databases.retrieve({ database_id: LEAVE_DB_ID }));
  const empDb  = await withRetry(() => notion.databases.retrieve({ database_id: EMPLOYEES_DB_ID }));

  const leaveProps = leaveDb.properties || {};
  const detected = {
    relationProp: null,     // عمود Relation باتجاه Employees
    statusProp: null,       // أول Status/Select (أو المفضّل إن وجد)
    employeeIdProp: null,   // عمود رقم الهوية في جدول الإجازات
  };

  // 1) التقط الـRelation المرتبط بقاعدة Employees
  for (const [name, prop] of Object.entries(leaveProps)) {
    if (prop.type === "relation" && prop.relation?.database_id === EMPLOYEES_DB_ID) {
      detected.relationProp = { name, ...prop };
      break;
    }
  }

  // 2) حالة الطلب: فضّل الاسم المفضل إن وجد، وإلا خذ أول status/select
  let candidateStatus = null;
  for (const [name, prop] of Object.entries(leaveProps)) {
    if (name === PREFERRED_STATUS_PROP && (prop.type === "status" || prop.type === "select")) {
      detected.statusProp = { name, ...prop };
      break;
    }
    if (!candidateStatus && (prop.type === "status" || prop.type === "select")) {
      candidateStatus = { name, ...prop };
    }
  }
  if (!detected.statusProp && candidateStatus) detected.statusProp = candidateStatus;

  // 3) عمود رقم الهوية في الإجازات (يفضّل الاسم المعلن)
  let candidateId = null;
  for (const [name, prop] of Object.entries(leaveProps)) {
    if (name === PREFERRED_EMPLOYEE_ID_PROP) {
      detected.employeeIdProp = { name, ...prop };
      break;
    }
    if (!candidateId && ["rich_text","title","number","phone_number","formula","rollup"].includes(prop.type)) {
      candidateId = { name, ...prop };
    }
  }
  if (!detected.employeeIdProp && candidateId) detected.employeeIdProp = candidateId;

  // لوق تعريفي يساعدك لو اختلفت المسميات
  console.log("Detected in Leave DB ->",
    "relation:", detected.relationProp?.name || "NOT FOUND",
    "| status:", detected.statusProp?.name || "NOT FOUND",
    "| employeeId:", detected.employeeIdProp?.name || "NOT FOUND"
  );

  if (!detected.relationProp) {
    throw new Error("لم أجد عمود Relation يربط بقاعدة الموظفين داخل جدول الإجازات. تأكد أن هناك Relation يشير لقاعدة Employees.");
  }
  if (!detected.employeeIdProp) {
    throw new Error("لم أجد عمودًا مناسبًا لرقم الهوية في جدول الإجازات.");
  }
  return detected;
}

// ابنِ فهرس الموظفين: رقم الهوية -> page_id
async function buildEmployeeIndex(employeeIdPropName) {
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
      const idProp = row.properties[employeeIdPropName] || row.properties[PREFERRED_EMPLOYEE_ID_PROP];
      const civilId = getCivilIdFromProperty(idProp);
      if (civilId) index[civilId] = row.id;
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return index;
}

// أصلح طلبات الإجازة
async function fixLeaveRequests(schema, employeeIndex) {
  let cursor;

  // لاحظ: نستخدم أسماء الحقول المكتشفة
  const REL = schema.relationProp.name;
  const EMP_ID = schema.employeeIdProp.name;

  // فلتر: (العلاقة فاضية) OR (الحالة فاضية) + وجود رقم هوية
  const filter = {
    and: [
      {
        or: [
          { property: REL, relation: { is_empty: true } },
          ...(schema.statusProp?.type === "status" ? [{ property: schema.statusProp.name, status: { is_empty: true } }] : []),
          ...(schema.statusProp?.type === "select" ? [{ property: schema.statusProp.name, select: { is_empty: true } }] : []),
        ],
      },
      {
        or: [
          { property: EMP_ID, rich_text: { is_not_empty: true } },
          { property: EMP_ID, number: { is_not_empty: true } },
          { property: EMP_ID, phone_number: { is_not_empty: true } },
          { property: EMP_ID, formula: { string: { is_not_empty: true } } },
          { property: EMP_ID, formula: { number: { is_not_empty: true } } },
          { property: EMP_ID, rollup: { any: { rich_text: { is_not_empty: true } } } },
        ],
      },
    ],
  };

  do {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: LEAVE_DB_ID,
        start_cursor: cursor,
        page_size: 100,
        filter,
      })
    );

    for (const row of res.results) {
      const leavePageId = row.id;

      const relProp = row.properties[REL];
      const statusProp = schema.statusProp ? row.properties[schema.statusProp.name] : null;
      const idProp = row.properties[EMP_ID];

      const needLink = !(relProp?.type === "relation" && relProp.relation?.length > 0);
      const needPending = schema.statusProp ? isStatusEmpty(statusProp) : false;

      if (!needLink && !needPending) continue;

      const props = {};

      // اربط الموظف
      if (needLink) {
        const civilId = getCivilIdFromProperty(idProp);
        if (civilId) {
          const employeePageId = employeeIndex[civilId];
          if (employeePageId) {
            props[REL] = { relation: [{ id: employeePageId }] };
          } else {
            console.log("No employee match for", civilId, "-> leave", leavePageId);
          }
        } else {
          console.log("Leave has no civilId:", leavePageId);
        }
      }

      // اضبط الحالة "قيد الانتظار"
      if (needPending) {
        Object.assign(props, buildPendingStatusUpdate(schema.statusProp));
      }

      if (Object.keys(props).length) {
        await withRetry(() => notion.pages.update({ page_id: leavePageId, properties: props }));
        console.log(
          `Updated ${leavePageId}:`
          + (needLink ? " linked;" : "")
          + (needPending ? " status=قيد الانتظار;" : "")
        );
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

// ===== التشغيل =====
async function main() {
  if (!process.env.NOTION_TOKEN || !EMPLOYEES_DB_ID || !LEAVE_DB_ID) {
    throw new Error("Missing NOTION_TOKEN or database IDs env vars.");
  }

  console.log("Building schema…");
  const schema = await detectLeaveSchema(); // ← يكتشف أسماء الأعمدة الحقيقية

  console.log("Building employee index…");
  const employeeIndex = await buildEmployeeIndex(PREFERRED_EMPLOYEE_ID_PROP);

  console.log("Employees indexed:", Object.keys(employeeIndex).length);

  console.log("Fixing leave requests…");
  await fixLeaveRequests(schema, employeeIndex);

  console.log("Done ✅");
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err);
  if (err?.body) console.error(err.body);
  process.exit(1);
});
