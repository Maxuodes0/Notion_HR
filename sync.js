#!/usr/bin/env node
/**
 * Notion Employee-Leave Request Sync Script (JavaScript)
 * ======================================================
 * This script syncs employee data with leave requests in Notion:
 * - Links leave requests to employees by matching ID numbers
 * - Sets default status for empty leave request statuses
 * - Handles Arabic/Hindi numerals conversion
 * - Protects against Notion API rate limits
 */

const { Client } = require('@notionhq/client');

/**
 * NotionSync class handles syncing between Notion databases
 */
class NotionSync {
  /**
   * Initialize the Notion sync client
   * @param {string} apiKey - Notion integration API key
   * @param {string} employeesDbId - Database ID for employees table
   * @param {string} leaveRequestsDbId - Database ID for leave requests table
   */
  constructor(apiKey, employeesDbId, leaveRequestsDbId) {
    this.notion = new Client({ auth: apiKey });
    this.employeesDbId = employeesDbId;
    this.leaveRequestsDbId = leaveRequestsDbId;
    this.idToPageMap = new Map();
  }

  /**
   * Normalize ID numbers by converting Arabic/Hindi numerals to Western numerals
   * @param {any} idValue - The ID value (can be string, number, or null)
   * @returns {string|null} Normalized ID as string, or null if invalid
   */
  static normalizeIdNumber(idValue) {
    if (!idValue && idValue !== 0) {
      return null;
    }

    // Convert to string first
    let idStr = String(idValue).trim();

    if (!idStr) {
      return null;
    }

    // Arabic-Indic (Eastern Arabic) numerals: ٠١٢٣٤٥٦٧٨٩
    const arabicNumerals = '٠١٢٣٤٥٦٧٨٩';
    const westernNumerals = '0123456789';

    // Hindi numerals: ०१२३४५६७८९
    const hindiNumerals = '०१२३४५६७८९';

    // Replace Arabic numerals
    for (let i = 0; i < arabicNumerals.length; i++) {
      idStr = idStr.replace(new RegExp(arabicNumerals[i], 'g'), westernNumerals[i]);
    }

    // Replace Hindi numerals
    for (let i = 0; i < hindiNumerals.length; i++) {
      idStr = idStr.replace(new RegExp(hindiNumerals[i], 'g'), westernNumerals[i]);
    }

    // Remove any non-numeric characters
    const normalized = idStr.replace(/\D/g, '');

    return normalized || null;
  }

  /**
   * Execute Notion API call with automatic retry on rate limit (429 error)
   * @param {Function} apiCall - The API function to call
   * @param {number} maxRetries - Maximum number of retry attempts
   * @returns {Promise} The result of the API call
   */
  async apiCallWithRetry(apiCall, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        const isRateLimit = 
          error.code === 'rate_limited' || 
          error.status === 429 ||
          (error.message && error.message.includes('rate_limited'));

        if (isRateLimit && attempt < maxRetries - 1) {
          // Exponential backoff: 1, 2, 4, 8, 16 seconds
          const waitTime = Math.pow(2, attempt);
          console.log(`⚠️  Rate limit hit. Waiting ${waitTime} seconds before retry ${attempt + 1}/${maxRetries}...`);
          await this.sleep(waitTime * 1000);
        } else if (isRateLimit) {
          console.log(`❌ Rate limit exceeded after ${maxRetries} attempts`);
          throw error;
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Extract value from Notion property safely
   * @param {object} properties - The properties object from a Notion page
   * @param {string} propertyName - Name of the property to extract
   * @param {string} propertyType - Expected type
   * @returns {any} The extracted value or null
   */
  extractPropertyValue(properties, propertyName, propertyType) {
    if (!properties[propertyName]) {
      return null;
    }

    const prop = properties[propertyName];

    try {
      switch (propertyType) {
        case 'title':
          return prop.title?.[0]?.plain_text || '';
        
        case 'rich_text':
          return prop.rich_text?.[0]?.plain_text || '';
        
        case 'number':
          return prop.number;
        
        case 'select':
          return prop.select?.name || null;
        
        case 'status':
          return prop.status?.name || null;
        
        case 'relation':
          return prop.relation || [];
        
        default:
          return null;
      }
    } catch (error) {
      return null;
    }
  }

  /**
   * Build an index mapping ID numbers to employee page IDs
   * Reads all employees from the employees database
   */
  async buildEmployeeIndex() {
    console.log('🔍 Building employee index...');

    let hasMore = true;
    let startCursor = undefined;
    let employeeCount = 0;

    while (hasMore) {
      const response = await this.apiCallWithRetry(async () => {
        return await this.notion.databases.query({
          database_id: this.employeesDbId,
          start_cursor: startCursor,
        });
      });

      for (const page of response.results) {
        const pageId = page.id;
        const properties = page.properties;

        // Try to get ID number from different possible property names and types
        let idNumber = null;

        // Try common property names
        const idPropertyNames = ['رقم الهوية', 'ID Number', 'رقم'];
        
        for (const propName of idPropertyNames) {
          if (properties[propName]) {
            const propType = properties[propName].type;
            
            if (propType === 'number') {
              idNumber = this.extractPropertyValue(properties, propName, 'number');
            } else if (propType === 'rich_text') {
              idNumber = this.extractPropertyValue(properties, propName, 'rich_text');
            }

            if (idNumber) {
              break;
            }
          }
        }

        // Normalize the ID
        const normalizedId = NotionSync.normalizeIdNumber(idNumber);

        if (normalizedId) {
          this.idToPageMap.set(normalizedId, pageId);
          employeeCount++;

          // Get employee name for logging
          const employeeName = 
            this.extractPropertyValue(properties, 'اسم الموظف', 'title') ||
            this.extractPropertyValue(properties, 'Name', 'title') ||
            'Unknown';

          console.log(`  ✓ ${employeeName}: ${normalizedId} → ${pageId}`);
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    console.log(`✅ Indexed ${employeeCount} employees\n`);
  }

  /**
   * Sync leave requests with employee data
   * - Link requests to employees by matching ID numbers
   * - Set default status if empty
   */
  async syncLeaveRequests() {
    console.log('🔄 Syncing leave requests...');

    let hasMore = true;
    let startCursor = undefined;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    while (hasMore) {
      const response = await this.apiCallWithRetry(async () => {
        return await this.notion.databases.query({
          database_id: this.leaveRequestsDbId,
          start_cursor: startCursor,
        });
      });

      for (const page of response.results) {
        const pageId = page.id;
        const properties = page.properties;

        // Extract ID number from leave request
        let requestId = null;
        const idPropertyNames = ['رقم الهوية', 'ID Number', 'رقم'];

        for (const propName of idPropertyNames) {
          if (properties[propName]) {
            const propType = properties[propName].type;

            if (propType === 'number') {
              requestId = this.extractPropertyValue(properties, propName, 'number');
            } else if (propType === 'rich_text') {
              requestId = this.extractPropertyValue(properties, propName, 'rich_text');
            }

            if (requestId) {
              break;
            }
          }
        }

        const normalizedRequestId = NotionSync.normalizeIdNumber(requestId);

        if (!normalizedRequestId) {
          console.log(`  ⚠️  Skipping request ${pageId}: No valid ID number`);
          skippedCount++;
          continue;
        }

        // Check if we need to update this record
        const updates = {};

        // 1. Check employee relation
        let employeeRelation = null;
        let relationPropName = null;
        const relationPropertyNames = ['اسم الموظف', 'Employee Name', 'الموظف'];

        for (const propName of relationPropertyNames) {
          if (properties[propName]) {
            employeeRelation = this.extractPropertyValue(properties, propName, 'relation');
            relationPropName = propName;
            break;
          }
        }

        if (this.idToPageMap.has(normalizedRequestId)) {
          const employeePageId = this.idToPageMap.get(normalizedRequestId);

          // Check if relation needs update
          const existingRelationIds = (employeeRelation || []).map(r => r.id);
          
          if (!existingRelationIds.includes(employeePageId)) {
            updates[relationPropName] = {
              relation: [{ id: employeePageId }],
            };
          }
        }

        // 2. Check status
        let statusValue = null;
        let statusPropName = null;
        const statusPropertyNames = ['حالة الطلب', 'Status', 'الحالة'];

        for (const propName of statusPropertyNames) {
          if (properties[propName]) {
            const propType = properties[propName].type;

            if (propType === 'select') {
              statusValue = this.extractPropertyValue(properties, propName, 'select');
            } else if (propType === 'status') {
              statusValue = this.extractPropertyValue(properties, propName, 'status');
            }

            statusPropName = propName;
            break;
          }
        }

        if (statusPropName && !statusValue) {
          const propType = properties[statusPropName].type;

          if (propType === 'select') {
            updates[statusPropName] = {
              select: { name: 'قيد الانتظار' },
            };
          } else if (propType === 'status') {
            updates[statusPropName] = {
              status: { name: 'قيد الانتظار' },
            };
          }
        }

        // Apply updates if any
        if (Object.keys(updates).length > 0) {
          try {
            await this.apiCallWithRetry(async () => {
              return await this.notion.pages.update({
                page_id: pageId,
                properties: updates,
              });
            });

            const updateDesc = [];
            if (relationPropName in updates) {
              updateDesc.push(`linked to employee (ID: ${normalizedRequestId})`);
            }
            if (statusPropName in updates) {
              updateDesc.push("status set to 'قيد الانتظار'");
            }

            console.log(`  ✓ Updated request ${pageId}: ${updateDesc.join(', ')}`);
            updatedCount++;

            // Small delay to avoid rate limiting
            await this.sleep(300);

          } catch (error) {
            console.log(`  ❌ Error updating ${pageId}: ${error.message}`);
            errorCount++;
          }
        } else {
          skippedCount++;
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    console.log(`\n📊 Sync Summary:`);
    console.log(`  ✅ Updated: ${updatedCount}`);
    console.log(`  ⏭️  Skipped: ${skippedCount}`);
    console.log(`  ❌ Errors: ${errorCount}`);
  }

  /**
   * Execute the full sync process
   */
  async run() {
    console.log('='.repeat(60));
    console.log('🚀 Starting Notion Sync Process');
    console.log('='.repeat(60) + '\n');

    try {
      await this.buildEmployeeIndex();
      await this.syncLeaveRequests();

      console.log('\n' + '='.repeat(60));
      console.log('✅ Sync completed successfully!');
      console.log('='.repeat(60));

    } catch (error) {
      console.log(`\n❌ Fatal error: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  // Load configuration from environment variables
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  const EMPLOYEES_DB_ID = process.env.EMPLOYEES_DB_ID;
  const LEAVE_REQUESTS_DB_ID = process.env.LEAVE_REQUESTS_DB_ID;

  // Validate configuration
  if (!NOTION_API_KEY || !EMPLOYEES_DB_ID || !LEAVE_REQUESTS_DB_ID) {
    console.log('❌ Error: Missing required environment variables!');
    console.log('\nPlease set the following environment variables:');
    console.log('  - NOTION_API_KEY: Your Notion integration API key');
    console.log('  - EMPLOYEES_DB_ID: Database ID for employees table');
    console.log('  - LEAVE_REQUESTS_DB_ID: Database ID for leave requests table');
    console.log('\nExample (Linux/Mac):');
    console.log("  export NOTION_API_KEY='secret_...'");
    console.log("  export EMPLOYEES_DB_ID='...'");
    console.log("  export LEAVE_REQUESTS_DB_ID='...'");
    console.log('\nExample (Windows PowerShell):');
    console.log('  $env:NOTION_API_KEY="secret_..."');
    console.log('  $env:EMPLOYEES_DB_ID="..."');
    console.log('  $env:LEAVE_REQUESTS_DB_ID="..."');
    process.exit(1);
  }

  // Run the sync
  const sync = new NotionSync(
    NOTION_API_KEY,
    EMPLOYEES_DB_ID,
    LEAVE_REQUESTS_DB_ID
  );

  try {
    await sync.run();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { NotionSync };
