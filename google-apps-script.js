/**
 * Google Apps Script — StreetEasy Listing Export
 *
 * Deploy as a web app:
 *   1. Open https://script.google.com and create a new project
 *   2. Paste this code into Code.gs
 *   3. Click Deploy > New deployment
 *   4. Select type: Web app
 *   5. Set "Execute as" to yourself, "Who has access" to "Anyone"
 *   6. Click Deploy and copy the web app URL
 *   7. Paste that URL into the Tampermonkey script when prompted
 */

const HEADERS = [
  'Timestamp',
  'Address',
  'Neighborhood',
  'Price',
  'Beds',
  'Baths',
  'Rooms',
  'Sqft',
  'Building Name',
  'Listing URL',
  'Walking Time',
  'Transit Time',
  'Transit Route',
  '311 Total',
  '311 Building',
  '311 Safety',
  'HPD Violations Total',
  'HPD Violations Open',
  'HPD Class C',
  'DOB Active Permits',
  'Notes',
];

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    const data = JSON.parse(e.postData.contents);

    // Auto-create headers on first run
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    const row = [
      new Date().toISOString(),
      data.address || '',
      data.neighborhood || '',
      data.price || '',
      data.beds || '',
      data.baths || '',
      data.rooms || '',
      data.sqft || '',
      data.buildingName || '',
      data.listingUrl || '',
      data.walkingTime || '',
      data.transitTime || '',
      data.transitRoute || '',
      data.complaints311Total != null ? data.complaints311Total : '',
      data.complaints311Building != null ? data.complaints311Building : '',
      data.complaints311Safety != null ? data.complaints311Safety : '',
      data.hpdViolationsTotal != null ? data.hpdViolationsTotal : '',
      data.hpdViolationsOpen != null ? data.hpdViolationsOpen : '',
      data.hpdClassC != null ? data.hpdClassC : '',
      data.dobActivePermits != null ? data.dobActivePermits : '',
      data.notes || '',
    ];

    sheet.appendRow(row);

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'ok', row: sheet.getLastRow() })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', message: 'StreetEasy export endpoint is live. Use POST to add rows.' })
  ).setMimeType(ContentService.MimeType.JSON);
}
