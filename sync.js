#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Notion Employee-Leave Request Sync Script
==========================================
This script syncs employee data with leave requests in Notion:
- Links leave requests to employees by matching ID numbers
- Sets default status for empty leave request statuses
- Handles Arabic/Hindi numerals conversion
- Protects against Notion API rate limits
"""

import os
import time
from typing import Dict, Any, Optional
from notion_client import Client
from notion_client.errors import APIResponseError


class NotionSync:
    """Handles syncing between Notion databases with rate limit protection."""
    
    def __init__(self, api_key: str, employees_db_id: str, leave_requests_db_id: str):
        """
        Initialize the Notion sync client.
        
        Args:
            api_key: Notion integration API key
            employees_db_id: Database ID for employees table
            leave_requests_db_id: Database ID for leave requests table
        """
        self.notion = Client(auth=api_key)
        self.employees_db_id = employees_db_id
        self.leave_requests_db_id = leave_requests_db_id
        self.id_to_page_map: Dict[str, str] = {}
        
    @staticmethod
    def normalize_id_number(id_value: Any) -> Optional[str]:
        """
        Normalize ID numbers by converting Arabic/Hindi numerals to Western numerals.
        
        Args:
            id_value: The ID value (can be string, number, or None)
            
        Returns:
            Normalized ID as string, or None if invalid
        """
        if id_value is None:
            return None
            
        # Convert to string first
        id_str = str(id_value).strip()
        
        if not id_str:
            return None
        
        # Arabic-Indic (Eastern Arabic) numerals: ٠١٢٣٤٥٦٧٨٩
        arabic_to_western = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
        
        # Hindi numerals: ०१२३४५६७८९
        hindi_to_western = str.maketrans('०१२३४५६७८९', '0123456789')
        
        # Apply both translations
        normalized = id_str.translate(arabic_to_western).translate(hindi_to_western)
        
        # Remove any non-numeric characters
        normalized = ''.join(c for c in normalized if c.isdigit())
        
        return normalized if normalized else None
    
    def api_call_with_retry(self, func, *args, max_retries: int = 5, **kwargs):
        """
        Execute Notion API call with automatic retry on rate limit (429 error).
        
        Args:
            func: The API function to call
            max_retries: Maximum number of retry attempts
            *args, **kwargs: Arguments to pass to the function
            
        Returns:
            The result of the API call
        """
        for attempt in range(max_retries):
            try:
                return func(*args, **kwargs)
            except APIResponseError as e:
                if e.code == 'rate_limited' or (hasattr(e, 'status') and e.status == 429):
                    if attempt < max_retries - 1:
                        # Extract retry-after from headers if available, otherwise use exponential backoff
                        wait_time = 2 ** attempt  # Exponential backoff: 1, 2, 4, 8, 16 seconds
                        print(f"⚠️  Rate limit hit. Waiting {wait_time} seconds before retry {attempt + 1}/{max_retries}...")
                        time.sleep(wait_time)
                    else:
                        print(f"❌ Rate limit exceeded after {max_retries} attempts")
                        raise
                else:
                    raise
        
    def extract_property_value(self, properties: Dict, property_name: str, property_type: str) -> Any:
        """
        Extract value from Notion property safely.
        
        Args:
            properties: The properties dictionary from a Notion page
            property_name: Name of the property to extract
            property_type: Expected type (title, rich_text, number, select, status, relation)
            
        Returns:
            The extracted value or None
        """
        if property_name not in properties:
            return None
            
        prop = properties[property_name]
        
        try:
            if property_type == 'title':
                return prop.get('title', [{}])[0].get('plain_text', '') if prop.get('title') else ''
            elif property_type == 'rich_text':
                return prop.get('rich_text', [{}])[0].get('plain_text', '') if prop.get('rich_text') else ''
            elif property_type == 'number':
                return prop.get('number')
            elif property_type == 'select':
                return prop.get('select', {}).get('name') if prop.get('select') else None
            elif property_type == 'status':
                return prop.get('status', {}).get('name') if prop.get('status') else None
            elif property_type == 'relation':
                return prop.get('relation', [])
        except (KeyError, IndexError, TypeError):
            return None
    
    def build_employee_index(self):
        """
        Build an index mapping ID numbers to employee page IDs.
        Reads all employees from the employees database.
        """
        print("🔍 Building employee index...")
        
        has_more = True
        start_cursor = None
        employee_count = 0
        
        while has_more:
            response = self.api_call_with_retry(
                self.notion.databases.query,
                database_id=self.employees_db_id,
                start_cursor=start_cursor
            )
            
            for page in response.get('results', []):
                page_id = page['id']
                properties = page['properties']
                
                # Try to get ID number from different possible property names and types
                id_number = None
                
                # Try common property names
                for prop_name in ['رقم الهوية', 'ID Number', 'رقم']:
                    if prop_name in properties:
                        prop_type = properties[prop_name]['type']
                        if prop_type == 'number':
                            id_number = self.extract_property_value(properties, prop_name, 'number')
                        elif prop_type == 'rich_text':
                            id_number = self.extract_property_value(properties, prop_name, 'rich_text')
                        
                        if id_number:
                            break
                
                # Normalize the ID
                normalized_id = self.normalize_id_number(id_number)
                
                if normalized_id:
                    self.id_to_page_map[normalized_id] = page_id
                    employee_count += 1
                    
                    # Get employee name for logging
                    employee_name = self.extract_property_value(properties, 'اسم الموظف', 'title') or \
                                  self.extract_property_value(properties, 'Name', 'title') or \
                                  'Unknown'
                    
                    print(f"  ✓ {employee_name}: {normalized_id} → {page_id}")
            
            has_more = response.get('has_more', False)
            start_cursor = response.get('next_cursor')
        
        print(f"✅ Indexed {employee_count} employees\n")
    
    def sync_leave_requests(self):
        """
        Sync leave requests with employee data:
        - Link requests to employees by matching ID numbers
        - Set default status if empty
        """
        print("🔄 Syncing leave requests...")
        
        has_more = True
        start_cursor = None
        updated_count = 0
        skipped_count = 0
        error_count = 0
        
        while has_more:
            response = self.api_call_with_retry(
                self.notion.databases.query,
                database_id=self.leave_requests_db_id,
                start_cursor=start_cursor
            )
            
            for page in response.get('results', []):
                page_id = page['id']
                properties = page['properties']
                
                # Extract ID number from leave request
                request_id = None
                for prop_name in ['رقم الهوية', 'ID Number', 'رقم']:
                    if prop_name in properties:
                        prop_type = properties[prop_name]['type']
                        if prop_type == 'number':
                            request_id = self.extract_property_value(properties, prop_name, 'number')
                        elif prop_type == 'rich_text':
                            request_id = self.extract_property_value(properties, prop_name, 'rich_text')
                        
                        if request_id:
                            break
                
                normalized_request_id = self.normalize_id_number(request_id)
                
                if not normalized_request_id:
                    print(f"  ⚠️  Skipping request {page_id}: No valid ID number")
                    skipped_count += 1
                    continue
                
                # Check if we need to update this record
                updates = {}
                
                # 1. Check employee relation
                employee_relation = None
                for prop_name in ['اسم الموظف', 'Employee Name', 'الموظف']:
                    if prop_name in properties:
                        employee_relation = self.extract_property_value(properties, prop_name, 'relation')
                        relation_prop_name = prop_name
                        break
                
                if normalized_request_id in self.id_to_page_map:
                    employee_page_id = self.id_to_page_map[normalized_request_id]
                    
                    # Check if relation needs update
                    if not employee_relation or employee_page_id not in [r['id'] for r in employee_relation]:
                        updates[relation_prop_name] = {
                            'relation': [{'id': employee_page_id}]
                        }
                
                # 2. Check status
                status_value = None
                status_prop_name = None
                
                for prop_name in ['حالة الطلب', 'Status', 'الحالة']:
                    if prop_name in properties:
                        prop_type = properties[prop_name]['type']
                        if prop_type == 'select':
                            status_value = self.extract_property_value(properties, prop_name, 'select')
                        elif prop_type == 'status':
                            status_value = self.extract_property_value(properties, prop_name, 'status')
                        
                        status_prop_name = prop_name
                        break
                
                if status_prop_name and not status_value:
                    prop_type = properties[status_prop_name]['type']
                    if prop_type == 'select':
                        updates[status_prop_name] = {
                            'select': {'name': 'قيد الانتظار'}
                        }
                    elif prop_type == 'status':
                        updates[status_prop_name] = {
                            'status': {'name': 'قيد الانتظار'}
                        }
                
                # Apply updates if any
                if updates:
                    try:
                        self.api_call_with_retry(
                            self.notion.pages.update,
                            page_id=page_id,
                            properties=updates
                        )
                        
                        update_desc = []
                        if relation_prop_name in updates:
                            update_desc.append(f"linked to employee (ID: {normalized_request_id})")
                        if status_prop_name in updates:
                            update_desc.append("status set to 'قيد الانتظار'")
                        
                        print(f"  ✓ Updated request {page_id}: {', '.join(update_desc)}")
                        updated_count += 1
                        
                        # Small delay to avoid rate limiting
                        time.sleep(0.3)
                        
                    except Exception as e:
                        print(f"  ❌ Error updating {page_id}: {str(e)}")
                        error_count += 1
                else:
                    skipped_count += 1
            
            has_more = response.get('has_more', False)
            start_cursor = response.get('next_cursor')
        
        print(f"\n📊 Sync Summary:")
        print(f"  ✅ Updated: {updated_count}")
        print(f"  ⏭️  Skipped: {skipped_count}")
        print(f"  ❌ Errors: {error_count}")
    
    def run(self):
        """Execute the full sync process."""
        print("=" * 60)
        print("🚀 Starting Notion Sync Process")
        print("=" * 60 + "\n")
        
        try:
            self.build_employee_index()
            self.sync_leave_requests()
            
            print("\n" + "=" * 60)
            print("✅ Sync completed successfully!")
            print("=" * 60)
            
        except Exception as e:
            print(f"\n❌ Fatal error: {str(e)}")
            raise


def main():
    """Main entry point."""
    # Load configuration from environment variables
    NOTION_API_KEY = os.getenv('NOTION_API_KEY')
    EMPLOYEES_DB_ID = os.getenv('EMPLOYEES_DB_ID')
    LEAVE_REQUESTS_DB_ID = os.getenv('LEAVE_REQUESTS_DB_ID')
    
    # Validate configuration
    if not all([NOTION_API_KEY, EMPLOYEES_DB_ID, LEAVE_REQUESTS_DB_ID]):
        print("❌ Error: Missing required environment variables!")
        print("\nPlease set the following environment variables:")
        print("  - NOTION_API_KEY: Your Notion integration API key")
        print("  - EMPLOYEES_DB_ID: Database ID for employees table")
        print("  - LEAVE_REQUESTS_DB_ID: Database ID for leave requests table")
        print("\nExample:")
        print("  export NOTION_API_KEY='secret_...'")
        print("  export EMPLOYEES_DB_ID='...'")
        print("  export LEAVE_REQUESTS_DB_ID='...'")
        return 1
    
    # Run the sync
    sync = NotionSync(
        api_key=NOTION_API_KEY,
        employees_db_id=EMPLOYEES_DB_ID,
        leave_requests_db_id=LEAVE_REQUESTS_DB_ID
    )
    
    sync.run()
    return 0


if __name__ == '__main__':
    exit(main())
