require('dotenv').config();
const { Client } = require('@notionhq/client');
const nodemailer = require('nodemailer');

// --------------------------------------
// إعداد Notion
// --------------------------------------
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const LEAVE_REQUESTS_DB_ID = process.env.DATABASE_ID_LEAVE_REQUESTS;

if (!process.env.NOTION_TOKEN || !LEAVE_REQUESTS_DB_ID) {
  console.error('❌ تأكد من ضبط NOTION_TOKEN و DATABASE_ID_LEAVE_REQUESTS في المتغيرات البيئية');
  process.exit(1);
}

// --------------------------------------
// إعداد البريد (Gmail)
// --------------------------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

async function sendEmail({ to, subject, text }) {
  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  try {
    await transporter.sendMail({ from, to, subject, text });
    console.log(`📧 تم إرسال إيميل إلى: ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ فشل الإرسال إلى ${to}:`, err.message);
    return false;
  }
}

// --------------------------------------
// دوال قراءة الخصائص من Notion
// --------------------------------------
function getStatus(page) {
  const prop = page.properties['حالة الطلب'];
  return prop?.select?.name || prop?.status?.name || '';
}
function getEmail(page) {
  return page.properties['الايميل']?.email || '';
}
function getName(page) {
  const prop = page.properties['اسم الموظف'];
  return prop?.title?.[0]?.plain_text || '';
}
function getEmailFlag(page) {
  const prop = page.properties['هل تم ارسال ايميل؟'];
  return prop?.rich_text?.[0]?.plain_text || '';
}
async function setEmailFlag(pageId, text) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      'هل تم ارسال ايميل؟': {
        rich_text: [{ type: 'text', text: { content: text } }],
      },
    },
  });
}

// --------------------------------------
// نصوص الإيميلات حسب الحالة
// --------------------------------------
function getEmailContent(status, name) {
  let subject, text;
  switch (status) {
    case 'قيد الانتظار':
      subject = 'تم استلام طلب الإجازة';
      text = `مرحباً ${name}،\n\nتم استلام طلب الإجازة الخاص بك وحالته الآن "قيد الانتظار".`;
      break;
    case 'موافقة':
      subject = 'تمت الموافقة على طلب الإجازة';
      text = `مرحباً ${name}،\n\nتمت الموافقة على طلب الإجازة الخاص بك، نتمنى لك إجازة سعيدة 🌴`;
      break;
    case 'مرفوضة':
      subject = 'تم رفض طلب الإجازة';
      text = `مرحباً ${name}،\n\nنأسف، تم رفض طلب الإجازة الخاص بك. يمكنك التواصل مع الموارد البشرية لمعرفة التفاصيل.`;
      break;
    default:
      subject = 'تحديث حالة الطلب';
      text = `مرحباً ${name}،\n\nتم تحديث حالة الطلب إلى "${status}".`;
  }
  return { subject, text };
}

// --------------------------------------
// قراءة جميع الطلبات من Notion
// --------------------------------------
async function fetchAllRequests() {
  const results = [];
  let cursor;
  do {
    const response = await notion.databases.query({
      database_id: LEAVE_REQUESTS_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return results;
}

// --------------------------------------
// الوظيفة الرئيسية
// --------------------------------------
async function run() {
  console.log('🚀 بدء فحص الحالات لإرسال الإيميلات...\n');

  const requests = await fetchAllRequests();
  let sent = 0, skipped = 0;

  for (const page of requests) {
    const status = getStatus(page);
    const email = getEmail(page);
    const name = getName(page);
    const flag = getEmailFlag(page);

    if (!status || !email) {
      skipped++;
      continue;
    }

    // إذا الحالة نفسها سبق وتم الإرسال لها → تجاوز
    if (flag && flag.trim() === status.trim()) {
      console.log(`⏭️ ${name} (${status}) سبق إرسال إيميل`);
      skipped++;
      continue;
    }

    const { subject, text } = getEmailContent(status, name);
    const ok = await sendEmail({ to: email, subject, text });

    if (ok) {
      await setEmailFlag(page.id, status);
      sent++;
    } else {
      skipped++;
    }
  }

  console.log('\n📊 ملخص الإرسال:');
  console.log(`✅ تم الإرسال: ${sent}`);
  console.log(`⏭️ تم التجاوز: ${skipped}`);
  console.log('✨ انتهى الإرسال.');
}

// --------------------------------------
// تشغيل مباشر
// --------------------------------------
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ خطأ:', err);
      process.exit(1);
    });
}
