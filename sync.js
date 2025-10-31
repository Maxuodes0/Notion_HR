const { Client } = require('@notionhq/client');

// تهيئة عميل Notion
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// معرفات قواعد البيانات
const EMPLOYEES_DB_ID = process.env.EMPLOYEES_DB_ID; // قاعدة بيانات الموظفين
const LEAVE_REQUESTS_DB_ID = process.env.LEAVE_REQUESTS_DB_ID; // قاعدة بيانات طلبات الإجازة

// تحويل الأرقام العربية والهندية إلى أرقام إنجليزية
function normalizeNumber(str) {
  if (!str) return '';
  
  const arabicNumbers = '٠١٢٣٤٥٦٧٨٩';
  const hindiNumbers = '۰۱۲۳۴۵۶۷۸۹';
  const englishNumbers = '0123456789';
  
  let result = String(str);
  
  // تحويل الأرقام العربية
  for (let i = 0; i < arabicNumbers.length; i++) {
    result = result.replace(new RegExp(arabicNumbers[i], 'g'), englishNumbers[i]);
  }
  
  // تحويل الأرقام الهندية
  for (let i = 0; i < hindiNumbers.length; i++) {
    result = result.replace(new RegExp(hindiNumbers[i], 'g'), englishNumbers[i]);
  }
  
  return result.trim();
}

// استخراج رقم الهوية من خصائص الصفحة
function extractIdNumber(properties) {
  // جرب أسماء مختلفة محتملة للحقل
  const possibleFields = ['رقم الهوية', 'رقم_الهوية', 'ID Number', 'ID', 'الرقم'];
  
  for (const fieldName of possibleFields) {
    if (properties[fieldName]) {
      const prop = properties[fieldName];
      
      // إذا كان الحقل من نوع number
      if (prop.type === 'number') {
        return prop.number ? String(prop.number) : null;
      }
      
      // إذا كان الحقل من نوع title
      if (prop.type === 'title' && prop.title.length > 0) {
        return prop.title[0].plain_text;
      }
      
      // إذا كان الحقل من نوع rich_text
      if (prop.type === 'rich_text' && prop.rich_text.length > 0) {
        return prop.rich_text[0].plain_text;
      }
      
      // إذا كان الحقل من نوع formula
      if (prop.type === 'formula') {
        if (prop.formula.type === 'string') {
          return prop.formula.string;
        } else if (prop.formula.type === 'number') {
          return String(prop.formula.number);
        }
      }
    }
  }
  
  return null;
}

// قراءة جميع الموظفين وبناء فهرس
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

// قراءة جميع طلبات الإجازة
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

// تحديث طلب الإجازة
async function updateLeaveRequest(requestId, employeePageId, needsStatusUpdate) {
  const updateData = {
    page_id: requestId,
    properties: {},
  };
  
  // تحديث علاقة الموظف
  if (employeePageId) {
    // جرب أسماء مختلفة محتملة لحقل العلاقة
    const possibleRelationFields = ['اسم الموظف', 'الموظف', 'Employee', 'Name'];
    
    for (const fieldName of possibleRelationFields) {
      updateData.properties[fieldName] = {
        relation: [{ id: employeePageId }],
      };
    }
  }
  
  // تحديث حالة الطلب إذا كانت فارغة
  if (needsStatusUpdate) {
    // جرب أسماء مختلفة محتملة لحقل الحالة
    const possibleStatusFields = ['حالة الطلب', 'الحالة', 'Status', 'State'];
    
    for (const fieldName of possibleStatusFields) {
      updateData.properties[fieldName] = {
        select: { name: 'قيد الانتظار' },
      };
    }
  }
  
  try {
    await notion.pages.update(updateData);
    console.log(`✅ تم تحديث طلب الإجازة: ${requestId}`);
    return true;
  } catch (error) {
    console.error(`❌ فشل تحديث طلب الإجازة ${requestId}:`, error.message);
    return false;
  }
}

// الوظيفة الرئيسية
async function syncNotionTables() {
  console.log('🚀 بدء عملية المزامنة...\n');
  
  try {
    // قراءة جميع الموظفين
    const employeesMap = await fetchEmployees();
    
    if (employeesMap.size === 0) {
      console.log('⚠️ لم يتم العثور على أي موظفين في قاعدة البيانات');
      return;
    }
    
    // قراءة جميع طلبات الإجازة
    const leaveRequests = await fetchLeaveRequests();
    
    if (leaveRequests.length === 0) {
      console.log('⚠️ لم يتم العثور على أي طلبات إجازة');
      return;
    }
    
    console.log('\n🔄 بدء معالجة طلبات الإجازة...\n');
    
    let updatedCount = 0;
    let skippedCount = 0;
    
    // معالجة كل طلب إجازة
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
      
      // التحقق من حالة الطلب
      let needsStatusUpdate = false;
      const statusFields = ['حالة الطلب', 'الحالة', 'Status', 'State'];
      
      for (const fieldName of statusFields) {
        if (request.properties[fieldName]) {
          const statusProp = request.properties[fieldName];
          
          if (statusProp.type === 'select' && !statusProp.select) {
            needsStatusUpdate = true;
            break;
          }
          
          if (statusProp.type === 'status' && !statusProp.status) {
            needsStatusUpdate = true;
            break;
          }
        }
      }
      
      // التحقق من علاقة الموظف الحالية
      let needsRelationUpdate = true;
      const relationFields = ['اسم الموظف', 'الموظف', 'Employee', 'Name'];
      
      for (const fieldName of relationFields) {
        if (request.properties[fieldName]) {
          const relationProp = request.properties[fieldName];
          
          if (relationProp.type === 'relation' && relationProp.relation.length > 0) {
            // التحقق إذا كانت العلاقة صحيحة بالفعل
            if (relationProp.relation[0].id === employeePageId) {
              needsRelationUpdate = false;
              break;
            }
          }
        }
      }
      
      // تحديث الطلب إذا لزم الأمر
      if (needsRelationUpdate || needsStatusUpdate) {
        const success = await updateLeaveRequest(
          request.id,
          needsRelationUpdate ? employeePageId : null,
          needsStatusUpdate
        );
        
        if (success) {
          updatedCount++;
          console.log(`   ✓ رقم الهوية: ${normalizedRequestId}`);
          if (needsRelationUpdate) console.log(`   ✓ تم ربط الموظف`);
          if (needsStatusUpdate) console.log(`   ✓ تم تعيين الحالة: قيد الانتظار`);
        }
      } else {
        console.log(`✓ الطلب محدث بالفعل: ${normalizedRequestId}`);
        skippedCount++;
      }
    }
    
    // ملخص النتائج
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

// تشغيل المزامنة
if (require.main === module) {
  syncNotionTables()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ فشلت عملية المزامنة:', error);
      process.exit(1);
    });
}

module.exports = { syncNotionTables };
