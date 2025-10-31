// sync.js
// Node.js (CommonJS)

const { Client } = require('@notionhq/client');

// --------------------------------------
// إعداد Notion + متغيرات البيئة
// --------------------------------------
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const EMPLOYEES_DB_ID = process.env.DATABASE_ID_EMPLOYEES;        // قاعدة الموظفين
const LEAVE_REQUESTS_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS; // قاعدة طلبات الإجازة

if (!process.env.NOTION_TOKEN) {
  console.error('❌ مفقود NOTION_TOKEN في المتغيرات البيئية');
  process.exit(1);
}
if (!EMPLOYEES_DB_ID || !LEAVE_REQUESTS_DB_ID) {
  console.error('❌ تأكد من ضبط DATABASE_ID_EMPLOYEES و DATABASE_ID_LEAVE_REQUESTS');
  process.exit(1);
}

// --------------------------------------
// أدوات مساعدة عامة
// --------------------------------------
function normalizeNumber(str) {
  if (!str) return '';
  const arabicNumbers = '٠١٢٣٤٥٦٧٨٩';
  const hindiNumbers = '۰۱۲۳۴۵۶۷۸۹';
  const englishNumbers = '0123456789';
  let result = String(str);
  for (let i = 0; i < arabicNumbers.length; i++) {
    result = result.replace(new RegExp(arabicNumbers[i], 'g'), englishNumbers[i]);
  }
  for (let i = 0; i < hindiNumbers.length; i++) {
    result = result.replace(new RegExp(hindiNumbers[i], 'g'), englishNumbers[i]);
  }
  return result.trim();
}

// يحاول استخراج رقم الهوية من عدة حقول مع مسح احتياطي
function extractIdNumber(properties) {
  const possibleFields = ['رقم الهوية', 'رقم_الهوية', 'ID Number', 'ID', 'الرقم'];
  for (const fieldName of possibleFields) {
    const prop = properties[fieldName];
    if (!prop) continue;

    if (prop.type === 'number') {
      return prop.number ? String(prop.number) : null;
    }
    if (prop.type === 'title' && prop.title.length > 0) {
      return prop.title.map(t => t.plain_text).join('').trim();
    }
    if (prop.type === 'rich_text' && prop.rich_text.length > 0) {
      return prop.rich_text.map(t => t.plain_text).join('').trim();
    }
    if (prop.type === 'formula') {
      if (prop.formula.type === 'string') return prop.formula.string;
      if (prop.formula.type === 'number') return String(prop.formula.number);
    }
  }

  // مسح احتياطي لأي خاصية قد تحتوي 9-12 رقم متتالي
  for (const prop of Object.values(properties)) {
    if (prop.type === 'rich_text' && prop.rich_text.length > 0) {
      const s = prop.rich_text.map(t => t.plain_text).join(' ');
      const m = (s || '').match(/\d{9,12}/);
      if (m) return m[0];
    }
    if (prop.type === 'number' && prop.number) {
      const m = String(prop.number).match(/\d{9,12}/);
      if (m) return m[0];
    }
    if (prop.type === 'title' && prop.title.length > 0) {
      const s = prop.title.map(t => t.plain_text).join(' ');
      const m = (s || '').match(/\d{9,12}/);
      if (m) return m[0];
    }
  }
  return null;
}

// --------------------------------------
// قراءة مخطط القواعد (Schema) وتحديد الحقول
// --------------------------------------
async function getDatabaseSchema(databaseId) {
  const db = await notion.databases.retrieve({ database_id: databaseId });
  return db; // يحتوي properties وأنواعها
}

function debugPrintAllProps(dbSchema, label) {
  console.log(`\n🧩 خصائص ${label}:`);
  const props = dbSchema?.properties || {};
  for (const [name, def] of Object.entries(props)) {
    console.log(` - ${name}: ${def.type}`);
  }
}

// ابحث عن حقل Relation في طلبات الإجازة الذي يربط قاعدة الموظفين
function findEmployeeRelationPropName(leaveDbSchema) {
  const props = leaveDbSchema.properties || {};

  // أولاً: Relation يربط مباشرة بقاعدة الموظفين
  for (const [propName, propDef] of Object.entries(props)) {
    if (propDef.type === 'relation' && propDef.relation?.database_id === EMPLOYEES_DB_ID) {
      return propName;
    }
  }
  // ثانياً: أي Relation كحل مؤقت (لو مافيه ربط مباشر)
  for (const [propName, propDef] of Object.entries(props)) {
    if (propDef.type === 'relation') {
      return propName;
    }
  }
  return null;
}

// ابحث عن حقل الحالة (يفضل status ثم select)
function findStatusProp(leaveDbSchema) {
  const props = leaveDbSchema.properties || {};
  for (const [propName, propDef] of Object.entries(props)) {
    if (propDef.type === 'status') {
      return { name: propName, kind: 'status', options: propDef.status?.options || [] };
    }
  }
  for (const [propName, propDef] of Object.entries(props)) {
    if (propDef.type === 'select') {
      return { name: propName, kind: 'select', options: propDef.select?.options || [] };
    }
  }
  return null;
}

// --------------------------------------
// تهيئة اسم الحالة "قيد الانتظار"
// --------------------------------------
function normalizeLabel(s = '') {
  return s.replace(/\s+/g, '').trim().toLowerCase();
}

// تُرجع اسمًا صالحًا للتعيين + هل موجود مسبقاً أم لا
function pickPendingName(kind, options) {
  const desired = 'قيد الانتظار';
  const desiredNorm = normalizeLabel(desired);

  // 1) إذا الاسم موجود فعلاً ضمن الخيارات → رجّعه
  const hit = (options || []).find(o => normalizeLabel(o.name) === desiredNorm);
  if (hit) return { name: hit.name, exists: true };

  if (kind === 'select') {
    // 2) select: نقدر ننشئه مباشرة
    return { name: desired, exists: false };
  }

  // 3) status: ما نقدر ننشئ خيار جديد. نختار أفضل بديل
  const toDo = (options || []).find(o => (o.status && o.status.group === 'to_do') || o.group === 'to_do');
  if (toDo) {
    console.warn('⚠️ (status) لا يوجد "قيد الانتظار"؛ تم اختيار أول خيار ضمن مجموعة To-do.');
    return { name: toDo.name, exists: true };
  }

  if ((options || []).length > 0) {
    console.warn('⚠️ (status) لا يوجد "قيد الانتظار"؛ تم اختيار أول خيار متاح.');
    return { name: options[0].name, exists: true };
  }

  console.warn('⚠️ (status) لا توجد أي خيارات مُعرّفة.');
  return { name: null, exists: false };
}

// --------------------------------------
// قراءة بيانات الموظفين والطلبات
// --------------------------------------
async function fetchEmployees() {
  console.log('📖 جاري قراءة قاعدة بيانات الموظفين...');
  const employeesMap = new Map();
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const response = await notion.databases.query({
      database_id: EMPLOYEES_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const idNumber = extractIdNumber(page.properties);
      if (idNumber) {
        const normalizedId = normalizeNumber(idNumber);
        employeesMap.set(normalizedId, page.id);
        console.log(`✅ تم إضافة موظف: رقم الهوية ${normalizedId}`);
      }
    }

    hasMore = response.has_more;
    cursor = response.next_cursor;
  }

  console.log(`📊 تم العثور على ${employeesMap.size} موظف في قاعدة البيانات`);
  return employeesMap;
}

async function fetchLeaveRequests() {
  console.log('📖 جاري قراءة قاعدة بيانات طلبات الإجازة...');
  const requests = [];
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const response = await notion.databases.query({
      database_id: LEAVE_REQUESTS_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    requests.push(...response.results);
    hasMore = response.has_more;
    cursor = response.next_cursor;
  }

  console.log(`📊 تم العثور على ${requests.length} طلب إجازة`);
  return requests;
}

// --------------------------------------
// تحديث ذكي يحترم المخطط الفعلي
// --------------------------------------
async function updateLeaveRequestSmart({
  requestId,
  employeePageId,     // string | null
  relationPropName,   // string | null
  statusProp,         // { name, kind, options } | null
  setStatusToPending, // boolean (متى؟ لما يكون فاضي)
}) {
  const properties = {};

  // Relation
  if (employeePageId && relationPropName) {
    properties[relationPropName] = { relation: [{ id: employeePageId }] };
  }

  // Status/Select (فقط إذا فاضي)
  if (setStatusToPending && statusProp) {
    const pick = pickPendingName(statusProp.kind, statusProp.options);
    if (pick.name) {
      if (statusProp.kind === 'status') {
        properties[statusProp.name] = { status: { name: pick.name } };
      } else {
        properties[statusProp.name] = { select: { name: pick.name } };
      }
      console.log(`   ↪︎ تعيين الحالة إلى: ${pick.name}${pick.exists ? '' : ' (تم إنشاؤه)'} (${statusProp.kind})`);
    } else {
      console.warn('⚠️ تعذّر تعيين الحالة: لا يوجد أي خيار صالح.');
    }
  }

  if (Object.keys(properties).length === 0) return false;

  try {
    await notion.pages.update({ page_id: requestId, properties });
    console.log(`✅ تم تحديث طلب الإجازة: ${requestId}`);
    return true;
  } catch (error) {
    console.error(`❌ فشل تحديث طلب الإجازة ${requestId}:`, error.message);
    return false;
  }
}

// --------------------------------------
// الوظيفة الرئيسية
// --------------------------------------
async function syncNotionTables() {
  console.log('🚀 بدء عملية المزامنة...\n');

  try {
    // 1) جلب مخطط قاعدة طلبات الإجازة
    const leaveSchema = await getDatabaseSchema(LEAVE_REQUESTS_DB_ID);

    // طباعة كل الخصائص للمراجعة (مفيد جدًا)
    debugPrintAllProps(leaveSchema, 'طلبات الإجازة');

    // 2) اكتشاف أسماء الحقول المهمة
    const relationPropName = findEmployeeRelationPropName(leaveSchema);
    const statusProp = findStatusProp(leaveSchema);

    console.log('\n🔎 حقول تم اكتشافها:');
    console.log('   • حقل ربط الموظف (relation):', relationPropName || 'غير موجود');
    console.log('   • حقل الحالة:', statusProp ? `${statusProp.name} (${statusProp.kind})` : 'غير موجود');

    if (!relationPropName) {
      console.warn('⚠️ لم يتم العثور على حقل Relation يربط بقاعدة الموظفين. لن يتم تحديث الربط.');
    }
    if (!statusProp) {
      console.warn('⚠️ لم يتم العثور على حقل حالة (status/select). لن يتم تحديث الحالة.');
    }

    // 3) قراءة جميع الموظفين
    const employeesMap = await fetchEmployees();
    if (employeesMap.size === 0) {
      console.log('⚠️ لم يتم العثور على أي موظفين في قاعدة البيانات');
      return;
    }

    // 4) قراءة جميع الطلبات
    const leaveRequests = await fetchLeaveRequests();
    if (leaveRequests.length === 0) {
      console.log('⚠️ لم يتم العثور على أي طلبات إجازة');
      return;
    }

    console.log('\n🔄 بدء معالجة طلبات الإجازة...\n');

    let updatedCount = 0;
    let skippedCount = 0;

    for (const request of leaveRequests) {
      const requestIdNumber = extractIdNumber(request.properties);

      if (!requestIdNumber) {
        console.log(`⚠️ طلب بدون رقم هوية: ${request.id}`);
        skippedCount++;
        continue;
      }

      const normalizedRequestId = normalizeNumber(requestIdNumber);
      const employeePageId = employeesMap.get(normalizedRequestId);

      if (!employeePageId) {
        console.log(`⚠️ لم يتم العثور على موظف برقم الهوية: ${normalizedRequestId}`);
        skippedCount++;
        continue;
      }

      // هل نحتاج نحدّث الحالة (فقط إذا كانت فاضية)؟
      let needsStatusUpdate = false;
      if (statusProp) {
        const p = request.properties[statusProp.name];
        if (!p) {
          // الحقل موجود في الـ DB لكنه غير ظاهر على الصفحة → اعتبره فاضي
          needsStatusUpdate = true;
        } else if (statusProp.kind === 'status' && !p.status) {
          needsStatusUpdate = true;
        } else if (statusProp.kind === 'select' && !p.select) {
          needsStatusUpdate = true;
        }
      }

      // هل نحتاج تحديث الربط Relation؟
      let needsRelationUpdate = !!relationPropName;
      if (relationPropName && request.properties[relationPropName]) {
        const r = request.properties[relationPropName];
        if (r.type === 'relation' && r.relation.length > 0 && r.relation[0].id === employeePageId) {
          needsRelationUpdate = false;
        }
      }

      if (needsRelationUpdate || needsStatusUpdate) {
        const ok = await updateLeaveRequestSmart({
          requestId: request.id,
          employeePageId: needsRelationUpdate ? employeePageId : null,
          relationPropName,
          statusProp,
          setStatusToPending: needsStatusUpdate,
        });

        if (ok) {
          updatedCount++;
          console.log(`   ✓ رقم الهوية: ${normalizedRequestId}`);
          if (needsRelationUpdate) console.log('   ✓ تم ربط الموظف');
          if (needsStatusUpdate) console.log('   ✓ تم تعيين الحالة (إن كانت فاضية)');
        }
      } else {
        console.log(`✓ الطلب محدث بالفعل: ${normalizedRequestId}`);
        skippedCount++;
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 ملخص عملية المزامنة:');
    console.log('='.repeat(50));
    console.log(`✅ تم تحديث: ${updatedCount} طلب`);
    console.log(`⏭️ تم تجاوز: ${skippedCount} طلب`);
    console.log(`📝 الإجمالي: ${leaveRequests.length} طلب`);
    console.log('='.repeat(50));
    console.log('✨ انتهت عملية المزامنة بنجاح!');

  } catch (error) {
    console.error('❌ حدث خطأ أثناء المزامنة:', error);
    throw error;
  }
}

// تشغيل مباشر
if (require.main === module) {
  syncNotionTables()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ فشلت عملية المزامنة:', error);
      process.exit(1);
    });
}

// للتصدير إن احتجته
module.exports = { syncNotionTables };
