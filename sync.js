import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ناخذ IDs من السيكرتس اللي بنحطها في GitHub Actions
const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;
const LEAVE_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS;

// << مهم جدا >>
// لازم الأسماء اللي تحت تطابق أسماء الأعمدة في نوتشن حرفيًا
// عمود رقم الهوية في الجدولين (الموظفين وطلبات الإجازة)
const EMPLOYEE_ID_PROP = "رقم الهوية";

// عمود الـ relation داخل جدول الإجازات (العمود اللي مفروض يمسك اسم الموظف)
const EMPLOYEE_REL_PROP = " اسم الموظف";

// helper: يطلع رقم الهوية من الحقل سواء كان نص ولا رقم ولا عنوان
function getCivilIdFromProperty(prop) {
  if (!prop) return null;

  if (prop.type === "rich_text") {
    return prop.rich_text[0]?.plain_text?.trim() || null;
  }

  if (prop.type === "number") {
    if (prop.number === null || prop.number === undefined) return null;
    return String(prop.number).trim();
  }

  if (prop.type === "title") {
    return prop.title[0]?.plain_text?.trim() || null;
  }

  return null;
}

// ناخذ جدول الموظفين ونبني index: رقم الهوية -> page_id
async function buildEmployeeIndex() {
  const index = {};
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: EMPLOYEES_DB_ID,
      start_cursor: cursor,
    });

    for (const row of res.results) {
      const idProp = row.properties[EMPLOYEE_ID_PROP];
      const civilId = getCivilIdFromProperty(idProp);

      if (civilId) {
        index[civilId] = row.id;
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return index;
}

// نمر على طلبات الإجازة ونحاول نعبي الـ relation إذا كان فاضي
async function fixLeaveRequests(employeeIndex) {
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: LEAVE_DB_ID,
      start_cursor: cursor,
    });

    for (const row of res.results) {
      const leavePageId = row.id;

      // هل الـ relation (Employees) أصلاً معبّي؟
      const relProp = row.properties[EMPLOYEE_REL_PROP];
      const alreadyLinked =
        relProp &&
        relProp.type === "relation" &&
        relProp.relation &&
        relProp.relation.length > 0;

      if (alreadyLinked) {
        // خلاص هذا الطلب مربوط بموظف، skip
        continue;
      }

      // نقرأ رقم الهوية من الطلب
      const idProp = row.properties[EMPLOYEE_ID_PROP];
      const civilId = getCivilIdFromProperty(idProp);

      if (!civilId) {
        console.log("Leave request", leavePageId, "has no civilId");
        continue;
      }

      // نطابقه مع جدول الموظفين
      const employeePageId = employeeIndex[civilId];
      if (!employeePageId) {
        console.log("No match for", civilId, "in leave", leavePageId);
        continue;
      }

      // نربط الطلب بالموظف عن طريق الـ relation
      await notion.pages.update({
        page_id: leavePageId,
        properties: {
          [EMPLOYEE_REL_PROP]: {
            type: "relation",
            relation: [{ id: employeePageId }],
          },
        },
      });

      console.log(
        `Linked leave ${leavePageId} -> ${civilId} (${employeePageId})`
      );
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

async function main() {
  console.log("Building employee index...");
  const employeeIndex = await buildEmployeeIndex();

  console.log("Fixing leave requests...");
  await fixLeaveRequests(employeeIndex);

  console.log("Done ✅");
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
