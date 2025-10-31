import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;
const LEAVE_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS;

// لو ودك تجبر اسم العلاقة يدويًا (تجاوز الاكتشاف التلقائي)
const RELATION_PROP_OVERRIDE = process.env.RELATION_PROP_OVERRIDE || null;

// أسماء محتملة لأعمدة الهوية (حسب صورك: "الهويه رقم" في الإجازات، و"رقم الهويه" في الموظفين)
const EMP_DB_ID_PROP_CANDIDATES   = ["رقم الهويه", "رقم الهوية", "الهويه رقم"];
const LEAVE_DB_ID_PROP_CANDIDATES = ["الهويه رقم", "رقم الهوية", "رقم الهويه"];

// حالة الطلب
const STATUS_PREFERRED_NAME = "حالة الطلب";
const PENDING_STATUS_VALUE  = "قيد الانتظار";

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
        await new Promise(r => setTimeout(r, Math.min(2000 * (i + 1), 8000)));
        continue;
      }
      if (i < retries - 1) continue;
    }
  }
  throw err;
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

function pickPropName(rowProps, candidates) {
  for (const name of candidates) if (rowProps[name]) return name;
  return null;
}

// ==== اكتشاف المخطط (schema) لجدول الإجازات ====
async function detectLeaveSchema() {
  const leaveDb = await withRetry(() => notion.databases.retrieve({ database_id: LEAVE_DB_ID }));
  const props = leaveDb.properties || {};

  // 1) Relation الذي يشير لقاعدة الموظفين
  let relationProp = null;
  if (RELATION_PROP_OVERRIDE && props[RELATION_PROP_OVERRIDE]?.type === "relation") {
    relationProp = { name: RELATION_PROP_OVERRIDE, ...props[RELATION_PROP_OVERRIDE] };
  } else {
    for (const [name, prop] of Object.entries(props)) {
      if (prop.type === "relation" && prop.relation?.database_id === EMPLOYEES_DB_ID) {
        relationProp = { name, ...prop };
        break;
      }
    }
  }
  if (!relationProp) {
    throw new Error(
      `لا يوجد عمود Relation يربط بقاعدة الموظفين داخل "طلبات الاجازة". `
      + `أضِف Relation جديد يربط بقاعدة الموظفين (مثلاً اسمه "الموظف") ثم أعد التشغيل. `
      + `أو مرر اسم العمود عبر RELATION_PROP_OVERRIDE.`
    );
  }

  // 2) عمود حالة الطلب (فضّل الاسم المعروف، وإلا أول status/select)
  let statusProp = null, fallback = null;
  for (const [name, prop] of Object.entries(props)) {
    if (name === STATUS_PREFERRED_NAME && (prop.type === "status" || prop.type === "select")) {
      statusProp = { name, ...prop }; break;
    }
    if (!fallback && (prop.type === "status" || prop.type === "select")) fallback = { name, ...prop };
  }
  if (!statusProp && fallback) statusProp = fallback;

  // 3) عمود الهوية في الإجازات
  let leaveIdPropName = null;
  for (const cand of LEAVE_DB_ID_PROP_CANDIDATES) if (props[cand]) { leaveIdPropName = cand; break; }
  if (!leaveIdPropName) {
    // آخر محاولة: التقط أول title/rich_text/number/phone/formula/rollup
    for (const [name, prop] of Object.entries(props)) {
      if (["title","rich_text","number","phone_number","formula","rollup"].includes(prop.type)) {
        leaveIdPropName = name; break;
      }
    }
  }
  if (!leaveIdPropName) throw new Error("لم أجد عمودًا مناسبًا لرقم الهوية داخل طلبات الاجازة.");

  console.log("Detected (Leave DB): relation=", relationProp.name, "| status=", statusProp?.name || "NONE", "| civilId=", leaveIdPropName);
  return { relationPropName: relationProp.name, statusProp, leaveIdPropName };
}

// ==== فهرس الموظفين: رقم الهوية -> page_id ====
async function buildEmployeeIndex() {
  const index = {};
  let cursor;

  do {
    const res = await withRetry(() =>
      notion.databases.query({ database_id: EMPLOYEES_DB_ID, start_cursor: cursor, page_size: 100 })
    );
    for (const row of res.results) {
      const props = row.properties;
      const empIdPropName = pickPropName(props, EMP_DB_ID_PROP_CANDIDATES) || Object.keys(props)[0];
      const civilId = readCivilIdFromProp(props[empIdPropName]);
      if (civilId) index[civilId] = row.id;
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return index;
}

// ==== ربط وتحديث الطلبات ====
async function fixLeaveRequests(schema, employeeIndex) {
  let cursor;

  const filter = {
    and: [
      {
        or: [
          { property: schema.relationPropName, relation: { is_empty: true } },
          ...(schema.statusProp?.type === "status" ? [{ property: schema.statusProp.name, status: { is_empty: true } }] : []),
          ...(schema.statusProp?.type === "select" ? [{ property: schema.statusProp.name, select: { is_empty: true } }] : []),
        ],
      },
      {
        or: [
          { property: schema.leaveIdPropName, rich_text: { is_not_empty: true } },
          { property: schema.leaveIdPropName, number: { is_not_empty: true } },
          { property: schema.leaveIdPropName, phone_number: { is_not_empty: true } },
          { property: schema.leaveIdPropName, formula: { string: { is_not_empty: true } } },
          { property: schema.leaveIdPropName, formula: { number: { is_not_empty: true } } },
          { property: schema.leaveIdPropName, rollup: { any: { rich_text: { is_not_empty: true } } } },
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
      const props = row.properties;
      const relProp = props[schema.relationPropName];
      const statusProp = schema.statusProp ? props[schema.statusProp.name] : null;
      const alreadyLinked = relProp?.type === "relation" && relProp.relation?.length > 0;

      const updates = {};

      // Link relation إذا فاضي
      if (!alreadyLinked) {
        const civilId = readCivilIdFromProp(props[schema.leaveIdPropName]);
        if (civilId) {
          const empPage = employeeIndex[civilId];
          if (empPage) updates[schema.relationPropName] = { relation: [{ id: empPage }] };
          else console.log("No employee match for", civilId, "->", row.id);
        } else {
          console.log("Leave row has no civil id:", row.id);
        }
      }

      // حالة الطلب = قيد الانتظار إذا فاضية
      if (schema.statusProp && isStatusEmpty(statusProp)) {
        if (schema.statusProp.type === "status") {
          updates[schema.statusProp.name] = { status: { name: PENDING_STATUS_VALUE } };
        } else if (schema.statusProp.type === "select") {
          updates[schema.statusProp.name] = { select: { name: PENDING_STATUS_VALUE } };
        }
      }

      if (Object.keys(updates).length) {
        await withRetry(() => notion.pages.update({ page_id: row.id, properties: updates }));
        console.log(`Updated ${row.id}`);
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

async function main() {
  if (!process.env.NOTION_TOKEN || !EMPLOYEES_DB_ID || !LEAVE_DB_ID) {
    throw new Error("Missing NOTION_TOKEN or database IDs.");
  }

  console.log("Detecting schema…");
  const schema = await detectLeaveSchema();   // ← هنا المشكلة كانت: لم يوجد Relation باسمك السابق
  console.log("Building employee index…");
  const employeeIndex = await buildEmployeeIndex();
  console.log("Employees indexed:", Object.keys(employeeIndex).length);

  console.log("Fixing leave requests…");
  await fixLeaveRequests(schema, employeeIndex);
  console.log("Done ✅");
}

main().catch(err => {
  console.error("ERROR:", err?.message || err);
  if (err?.body) console.error(err.body);
  process.exit(1);
});
