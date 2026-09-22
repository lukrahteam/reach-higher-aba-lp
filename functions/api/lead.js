/**
 * Reach Higher ABA — CF Pages Function
 * Path: /api/lead
 *
 * Handles both full form submissions and progressive/partial captures.
 * Creates / upserts GHL contacts in OUR GHL first (for Lukrah tracking),
 * then writes full UTM data directly to MQL sheet,
 * then forwards full-submit leads to the CLIENT's GHL as well.
 *
 * OUR GHL:
 *   Location: NTo0dHKMft9DfJU4PhwC (Reach Higher ABA — Lukrah)
 *   Pipeline: KiIFw3QQrGjqeYKdbTTg
 *   New Lead stage: ac11cac3-c337-41c2-bd92-3ac32447c9bb
 *
 * CLIENT GHL (Reach Higher ABA's own account):
 *   Location: CV24QvQB6KnATRbdvBxm
 *   PIT: set in env as GHL_CLIENT_PIT (pit-a0747a2b-1ddd-46fe-8a71-3dd1012d0595)
 *   Only full submits are forwarded (not partial/progressive captures).
 *
 * Environment variables (CF Pages → Settings → Environment Variables):
 *   GHL_PIT              Lukrah's PIT for the Reach Higher ABA sub-account
 *   GHL_CLIENT_PIT       Client's own GHL PIT
 *   GOOGLE_CLIENT_ID     Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET Google OAuth client secret
 *   GOOGLE_REFRESH_TOKEN Google OAuth refresh token
 *   SHEET_ID             MQL sheet ID (optional override)
 *
 * NOTE: The ghl-mql-webhook worker skips contacts tagged 'reach-higher-lp'
 * to avoid duplicate rows — this function writes the authoritative sheet row.
 *
 * Updated Sep 22 2026: Switched to MQL template format.
 * Tabs now named "Month Year - MQL" with full template formatting.
 */

const GHL_BASE  = 'https://services.leadconnectorhq.com';
const LOC_ID    = 'NTo0dHKMft9DfJU4PhwC';
const PIPELINE  = 'KiIFw3QQrGjqeYKdbTTg';
const STAGE_NEW = 'ac11cac3-c337-41c2-bd92-3ac32447c9bb';
const MQL_SHEET = '1ohuXz1dpLgXZLCF2cC3LFrcIERfrHpxt36JDQBMl2kY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// MQL Template headers (matches master template)
const MQL_HEADERS = [
  'Our Rating', 'Your Rating', 'DQ Reason', '1st Attempt Date/Time',
  'Date Created', 'Name', 'Email', 'Phone',
  'Call Summary', 'Call Transcript',
  'Child Age', 'Insurance', 'Diagnosis', 'Waitlist',
  'Traffic Source', 'Path / URL', 'Campaign', 'GCLID',
];

// ── OPTIONS preflight ────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── POST handler ─────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  const PIT           = env.GHL_PIT           || 'pit-cd550eee-19f8-4939-bcf4-e051feda6317';
  const CLIENT_PIT    = env.GHL_CLIENT_PIT    || 'pit-a0747a2b-1ddd-46fe-8a71-3dd1012d0595';
  const CLIENT_LOC_ID = env.GHL_CLIENT_LOC_ID || 'CV24QvQB6KnATRbdvBxm';

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const {
    firstName    = '',
    lastName     = '',
    phone        = '',
    email        = '',
    childAge     = '',
    insurance    = '',
    quizAge      = '',
    quizDiag     = '',
    quizWaitlist = '',
    partial      = false,
    source       = 'Landing Page',
    pageVariant  = 'main',
    gclid        = '',
    utmSource    = '',
    utmCampaign  = '',
  } = body;

  if (!phone && !email) {
    return json({ error: 'no_contact_info' }, 422);
  }

  const H = {
    'Authorization': `Bearer ${PIT}`,
    'Version':       '2021-07-28',
    'Content-Type':  'application/json',
  };

  const ageLabel = childAge || quizAge || '';
  const tags = [
    'reach-higher-lp',
    'utah-ut',
    pageVariant !== 'main' ? `lp-${pageVariant}` : null,
    partial ? 'partial-capture' : 'full-submit',
    insurance.toLowerCase().includes('medicaid') ? 'medicaid' : null,
    quizWaitlist === 'yes' ? 'waitlisted-elsewhere' : null,
  ].filter(Boolean);

  const noteLines = [
    '📋 LP Lead — Reach Higher ABA',
    `Page: ${pageVariant}`,
    `Capture type: ${partial ? 'progressive' : 'full submit'}`,
    ageLabel     && `Child age: ${ageLabel}`,
    quizDiag     && `Diagnosis status: ${quizDiag}`,
    quizWaitlist && `Waitlist status: ${quizWaitlist}`,
    insurance    && `Insurance: ${insurance}`,
    gclid        && `GCLID: ${gclid}`,
    utmSource    && `UTM source: ${utmSource}`,
    utmCampaign  && `UTM campaign: ${utmCampaign}`,
  ].filter(Boolean).join('\n');

  // ── 1. Create / update contact in OUR GHL ───────────────────────────────
  const contactPayload = {
    locationId:   LOC_ID,
    firstName:    firstName   || undefined,
    lastName:     lastName    || undefined,
    phone:        phone       || undefined,
    email:        email       || undefined,
    source,
    tags,
    gclId:        gclid       || undefined,
  };

  let contactId;
  try {
    const res = await fetch(`${GHL_BASE}/contacts/`, {
      method:  'POST',
      headers: H,
      body:    JSON.stringify(contactPayload),
    });
    const data = await res.json();
    contactId = data?.contact?.id;

    if (contactId && noteLines) {
      await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
        method:  'POST',
        headers: H,
        body:    JSON.stringify({ body: noteLines, userId: '' }),
      });
    }
  } catch (err) {
    console.error('GHL contact error:', err);
    return json({ error: 'ghl_contact_failed', detail: String(err) }, 502);
  }

  // ── 2. Add to pipeline in OUR GHL — full submit only ────────────────────
  let opportunityId;
  if (!partial && contactId && (phone || email)) {
    try {
      const oppName = [firstName, lastName].filter(Boolean).join(' ') || 'New Lead';
      const res = await fetch(`${GHL_BASE}/opportunities/`, {
        method:  'POST',
        headers: H,
        body:    JSON.stringify({
          locationId:      LOC_ID,
          contactId,
          pipelineId:      PIPELINE,
          pipelineStageId: STAGE_NEW,
          name:            `${oppName} — ABA Inquiry`,
          source,
          status:          'open',
          monetaryValue:   0,
        }),
      });
      const data = await res.json();
      opportunityId = data?.opportunity?.id;
    } catch (err) {
      console.error('GHL opportunity error:', err);
    }
  }

  // ── 3. Write to MQL Sheet — full submit only ─────────────────────────────
  if (!partial && contactId) {
    try {
      await writeToSheet(env, {
        firstName, lastName, email, phone,
        ageLabel, insurance,
        utmSource, utmCampaign, gclid,
        quizDiag, quizWaitlist, pageVariant,
        contactId,
      });
    } catch (err) {
      console.error('Sheet write error:', err);
      // Non-fatal — GHL contact already captured
    }
  }

  // ── 4. Forward to CLIENT'S GHL — full submit only ────────────────────────
  let clientContactId;
  if (!partial && (phone || email)) {
    try {
      const clientH = {
        'Authorization': `Bearer ${CLIENT_PIT}`,
        'Version':       '2021-07-28',
        'Content-Type':  'application/json',
      };

      const clientNote = [
        '📋 Lead from Lukrah LP — Reach Higher ABA',
        ageLabel     && `Child age: ${ageLabel}`,
        quizDiag     && `Diagnosis status: ${quizDiag}`,
        quizWaitlist && `Waitlist status: ${quizWaitlist}`,
        insurance    && `Insurance: ${insurance}`,
        gclid        && `GCLID: ${gclid}`,
        utmSource    && `UTM source: ${utmSource}`,
        utmCampaign  && `UTM campaign: ${utmCampaign}`,
      ].filter(Boolean).join('\n');

      const clientPayload = {
        locationId:   CLIENT_LOC_ID,
        firstName:    firstName   || undefined,
        lastName:     lastName    || undefined,
        phone:        phone       || undefined,
        email:        email       || undefined,
        source:       'Lukrah LP',
        tags:         ['lukrah-lp', 'google-ads'],
        gclId:        gclid       || undefined,
      };

      const clientRes = await fetch(`${GHL_BASE}/contacts/`, {
        method:  'POST',
        headers: clientH,
        body:    JSON.stringify(clientPayload),
      });
      const clientData = await clientRes.json();
      clientContactId = clientData?.contact?.id;

      if (clientContactId && clientNote) {
        await fetch(`${GHL_BASE}/contacts/${clientContactId}/notes`, {
          method:  'POST',
          headers: clientH,
          body:    JSON.stringify({ body: clientNote, userId: '' }),
        });
      }
    } catch (err) {
      console.error('Client GHL forward error:', err);
    }
  }

  return json({
    success:         true,
    contactId,
    opportunityId:   opportunityId  || null,
    clientContactId: clientContactId || null,
  });
}

// ── JSON helper ──────────────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Google Sheets helpers ────────────────────────────────────────────────────
function currentMonthMqlTab() {
  const now = new Date();
  return `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()} - MQL`;
}

async function getGoogleToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  return data.access_token || null;
}

async function writeToSheet(env, data) {
  const SHEET_ID = env.SHEET_ID || MQL_SHEET;
  const token    = await getGoogleToken(env);
  if (!token) { console.error('Sheet: failed to get Google token'); return; }

  const base    = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
  const auth    = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const tabName = currentMonthMqlTab();

  // Ensure tab exists with MQL template formatting
  const sheetRes  = await fetch(`${base}?fields=sheets.properties`, { headers: auth });
  const sheetData = await sheetRes.json();
  const tabs      = (sheetData.sheets || []).map(s => s.properties.title);

  if (!tabs.includes(tabName)) {
    // Create tab
    const addRes = await fetch(`${base}:batchUpdate`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ requests: [{
        addSheet: { properties: { title: tabName, gridProperties: { rowCount: 1000, columnCount: 18 } } }
      }] }),
    });
    const addData = await addRes.json();
    const newId = addData.replies?.[0]?.addSheet?.properties?.sheetId;

    if (newId || newId === 0) {
      await applyMqlFormatting(base, auth, newId);
    } else {
      // Fallback: just write plain headers
      const encHdr = encodeURIComponent(`'${tabName}'!A1`);
      await fetch(`${base}/values/${encHdr}?valueInputOption=USER_ENTERED`, {
        method: 'PUT', headers: auth,
        body: JSON.stringify({ values: [MQL_HEADERS] }),
      });
    }
  }

  // Build MQL row
  const fullName = [data.firstName, data.lastName].filter(Boolean).join(' ');
  const now  = new Date();
  const date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

  // Determine traffic source label
  let trafficSource = '';
  if (data.utmSource) {
    const src = data.utmSource.toLowerCase();
    if (src.includes('google')) trafficSource = 'Google Ads';
    else if (src.includes('meta') || src.includes('facebook')) trafficSource = 'Meta Ads';
    else trafficSource = data.utmSource;
  }

  const row = [
    'Needs Review',                          // A: Our Rating
    '',                                      // B: Your Rating
    '',                                      // C: DQ Reason
    '',                                      // D: 1st Attempt Date/Time
    `'${date}`,                              // E: Date Created
    fullName,                                // F: Name
    data.email        || '',                 // G: Email
    data.phone        || '',                 // H: Phone
    '',                                      // I: Call Summary
    '',                                      // J: Call Transcript
    data.ageLabel     || '',                 // K: Child Age
    data.insurance    || '',                 // L: Insurance
    data.quizDiag     || '',                 // M: Diagnosis
    data.quizWaitlist || '',                 // N: Waitlist
    trafficSource,                           // O: Traffic Source
    `LP - ${data.pageVariant || 'main'}`,    // P: Path / URL
    data.utmCampaign  || '',                 // Q: Campaign
    data.gclid        || '',                 // R: GCLID
  ];

  const encTab = encodeURIComponent(`'${tabName}'!A:R`);
  await fetch(
    `${base}/values/${encTab}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: auth, body: JSON.stringify({ values: [row], majorDimension: 'ROWS' }) },
  );
}

// ── Apply full MQL template formatting to a new tab ──────────────────────────
async function applyMqlFormatting(base, auth, sheetId) {
  const BLUE  = { red: 0.2901961, green: 0.5254902, blue: 0.9098039 };
  const RED   = { red: 0.9098039, green: 0.26666668, blue: 0.3764706 };
  const WHITE = { red: 1, green: 1, blue: 1 };
  const BLACK = { red: 0, green: 0, blue: 0 };
  const GRAY  = { red: 0.9372549, green: 0.9372549, blue: 0.9372549 };

  const headerCells = MQL_HEADERS.map((h, ci) => ({
    userEnteredValue: { stringValue: h },
    userEnteredFormat: {
      textFormat: { bold: true, fontFamily: 'Arial', foregroundColor: ci <= 3 ? WHITE : BLACK },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'BOTTOM',
      backgroundColor: ci === 0 ? BLUE : ci <= 3 ? RED : GRAY,
      ...(ci === 5 ? { wrapStrategy: 'CLIP' } : {}),
    },
  }));

  const COL_WIDTHS = [99, 107, 143, 165, 112, 147, 223, 68, 116, 120, 111, 111, 111, 111, 116, 94, 91, 77];

  const requests = [
    {
      updateCells: {
        rows: [{ values: headerCells }],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 3 } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    },
    ...COL_WIDTHS.map((w, ci) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: ci, endIndex: ci + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    })),
    // Dropdowns
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 0, endColumnIndex: 1 },
        rule: { condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Good Lead' }, { userEnteredValue: 'Needs Review' }, { userEnteredValue: 'Disqualified' },
        ] }, strict: true, showCustomUi: true },
      },
    },
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 1, endColumnIndex: 2 },
        rule: { condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Good Lead' }, { userEnteredValue: 'Contacted' },
          { userEnteredValue: 'Needs Review' }, { userEnteredValue: 'DQd' },
        ] }, strict: true, showCustomUi: true },
      },
    },
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 2, endColumnIndex: 3 },
        rule: { condition: { type: 'ONE_OF_LIST', values: [
          { userEnteredValue: 'Outside of Scope' }, { userEnteredValue: 'No Contact Info' },
          { userEnteredValue: 'Test/Spam' }, { userEnteredValue: 'Duplicate' }, { userEnteredValue: 'Other' },
        ] }, strict: true, showCustomUi: true },
      },
    },
    // Conditional formatting on Traffic Source (col 14)
    ...[
      ['Google Ads',   { red: 0.7176471, green: 0.88235295, blue: 0.8039216 }],
      ['Meta',         { red: 0.7882353, green: 0.85490197, blue: 0.972549 }],
      ['Organic',      { red: 0.9882353, green: 0.8980392,  blue: 0.8039216 }],
      ['Facebook Ads', { red: 0.7882353, green: 0.85490197, blue: 0.972549 }],
    ].map(([text, color]) => ({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 500, startColumnIndex: 14, endColumnIndex: 15 }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: text }] },
            format: { backgroundColor: color },
          },
        },
        index: 0,
      },
    })),
  ];

  await fetch(`${base}:batchUpdate`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ requests }),
  });
}
