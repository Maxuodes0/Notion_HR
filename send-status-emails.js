// send-status-emails.js

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
    pass: process.env.MAIL_PASS, // بدون مسافات في السيكريت
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
  if (!prop) return '';
  if (prop.type === 'select' && prop.select) return prop.select.name || '';
  if (prop.type === 'status' && prop.status) return prop.status.name || '';
  return '';
}

function getEmail(page) {
  const prop = page.properties['الايميل'];
  if (!prop || prop.type !== 'email') return '';
  return prop.email || '';
}

function getName(page) {
  const prop = page.properties['اسم الموظف'];
  if (!prop || prop.type !== 'title') return '';
  return (prop.title || []).map(t => t.plain_text).join(' ').trim();
}

function getEmailFlag(page) {
  const prop = page.properties['هل تم ارسال ايميل؟'];
  if (!prop || prop.type !== 'rich_text') return '';
  return (prop.rich_text || []).map(t => t.plain_text).join(' ').trim();
}

async function setEmailFlag(pageId, text) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      'هل تم ارسال ايميل؟': {
        rich_text: [
          {
            type: 'text',
            text: {
              content: text || 'تم الإرسال',
            },
          },
        ],
      },
    },
  });
}

// --------------------------------------
// نصوص الإيميل حسب حالة الطلب
// --------------------------------------
function getEmailContent(status, name) {
  let subject, text;

  switch (status) {
    case 'قيد الانتظار':
      subject = 'تم استلام طلب الإجازة';
      text =
`مرحباً ${name}،

تم استلام طلب الإجازة الخاص بك، وحالته الآن "قيد الانتظار".
سيتم مراجعة الطلب وإبلاغك بالتحديث حال توفره.

مع التحية،`;
      break;

    case 'موافقة':
      subject = 'تمت الموافقة على طلب الإجازة';
      text =
`مرحباً ${name}،

يسعدنا إبلاغك بأنه تمت الموافقة على طلب الإجازة الخاص بك ✅
نتمنى لك إجازة سعيدة، ولا تنس التنسيق مع مديرك المباشر بخصوص تسليم المهام.

مع تمنياتنا لك بالتوفيق،`;
      break;

    case 'مرفوضة':
      subject = 'تم رفض طلب الإجازة';
      text =
`مرحباً ${name}،

نود إبلاغك بأنه تم رفض طلب الإجازة الخاص بك.
للاستفسار عن تفاصيل أكثر حول سبب الرفض، يمكنك التواصل مع إدارة الموارد البشرية أو مديرك المباشر.

مع التحية،`;
      break;

    default:
      subject = 'تحديث حالة طلب الإجازة';
      text =
`مرحباً ${name}،

تم تحديث حالة طلب الإجازة الخاص بك إلى: "${status}".

مع التحية،`;
  }

  return { subject, text };
}

// --------------------------------------
// قراءة جميع الطلبات من قاعدة Notion
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
// الوظيفة الرئيسية مع توضيح سبب التجاوز
// --------------------------------------
async function run() {
  console.log('🚀 بدء فحص الحالات لإرسال الإيميلات...\n');

  const requests = await fetchAllRequests();
  let sent = 0;
  let skipped = 0;

  for (const page of requests) {
    const status = getStatus(page);
    const email = getEmail(page);
    const name = getName(page);
    const flag = getEmailFlag(page);

    console.log('------------------------------');
    console.log(`🔎 طلب: ${name || '(بدون اسم)'}`);
    console.log(`   حالة الطلب       : "${status || 'فاضي'}"`);
    console.log(`   الايميل           : "${email || 'فاضي'}"`);
    console.log(`   هل تم ارسال ايميل: "${flag || 'فاضي'}"`);

    // 1) لا يوجد حالة
    if (!status) {
      console.log('⏭️ تم التجاوز: حالة الطلب فاضية');
      skipped++;
      continue;
    }

    // 2) لا يوجد ايميل
    if (!email) {
      console.log('⏭️ تم التجاوز: الايميل فاضي');
      skipped++;
      continue;
    }

    // 3) سبق إرسال إيميل لنفس هذه الحالة
    if (flag && flag.trim() === status.trim()) {
      console.log('⏭️ تم التجاوز: سبق إرسال إيميل لنفس هذه الحالة');
      skipped++;
      continue;
    }

    // 4) إرسال الإيميل
    const { subject, text } = getEmailContent(status, name);

    console.log(`📨 محاولة إرسال إيميل إلى: ${email} (حالة: ${status})`);
    const ok = await sendEmail({ to: email, subject, text });

    if (ok) {
      await setEmailFlag(page.id, status);
      console.log('✅ تم الإرسال وتحديث حقل "هل تم ارسال ايميل؟"');
      sent++;
    } else {
      console.log('❌ فشل الإرسال لهذا الطلب');
      skipped++;
    }
  }

  console.log('\n📊 ملخص الإرسال:');
  console.log(`✅ تم الإرسال: ${sent}`);
  console.log(`⏭️ تم التجاوز: ${skipped}`);
  console.log('✨ انتهى الإرسال.');
}

// --------------------------------------
// تشغيل مباشر من السطر
// --------------------------------------
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ خطأ أثناء التنفيذ:', err);
      process.exit(1);
    });
}

module.exports = { run };
