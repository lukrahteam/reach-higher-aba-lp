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
 *   PIT: set in env as GHL_CLIENT_PIT
 *   Only full submits are forwarded (not partial/progressive captures).
 *   Needs their GHL locationId to be added once confirmed.
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

// ── OPTIONS preflight ────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// ── POST handler ─────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  const PIT        = env.GHL_PIT        || 'pit-cd550eee-19f8-4939-bcf4-e051feda6317';
  const CLIENT_PIT = env.GHL_CLIENT_PIT || 'pit-0aa83ca4-fa83-496b-bbb0-480a2800b767';

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
    'colorado-co',
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
    utmSource:    utmSource   || undefined,
    utmCampaign:  utmCampaign || undefined,
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
        firstName:    firstName   || undefined,
        lastName:     lastName    || undefined,
        phone:        phone       || undefined,
        email:        email       || undefined,
        source:       'Lukrah LP',
        tags:         ['lukrah-lp', 'google-ads'],
        gclId:        gclid       || undefined,
        utmSource:    utmSource   || undefined,
        utmCampaign:  utmCampaign || undefined,
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
const SHEET_HEADERS = [
  'Status', 'DQ Reason', 'Notes', '#', 'Date',
  'First Name', 'Last Name', 'Email', 'Phone',
  'Child Age', 'Insurance', 'Lead Type', 'Source / LP',
  'UTM Source', 'UTM Campaign', 'GCLID',
  'Quiz - Diagnosis', 'Quiz - Waitlist', 'Page Variant',
  'MQL Status', 'ICP Score', 'ICP Reasoning', 'GHL Contact ID',
];

function currentMonthTab() {
  const now = new Date();
  return `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()} - All Leads`;
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
  const tabName = currentMonthTab();

  // Ensure tab exists with full headers
  const sheetRes  = await fetch(`${base}?fields=sheets.properties`, { headers: auth });
  const sheetData = await sheetRes.json();
  const tabs      = (sheetData.sheets || []).map(s => s.properties.title);

  if (!tabs.includes(tabName)) {
    await fetch(`${base}:batchUpdate`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
    });
    const encHdr = encodeURIComponent(`'${tabName}'!A1`);
    await fetch(`${base}/values/${encHdr}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  // Lead number (count column D, subtract header)
  const countRes  = await fetch(`${base}/values/${encodeURIComponent(`'${tabName}'!D:D`)}`, { headers: auth });
  const countData = await countRes.json();
  const leadNum   = Math.max(0, (countData.values || []).length - 1) + 1;

  const now  = new Date();
  const date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

  const row = [
    'New', '', '',
    String(leadNum),
    `'${date}`,
    data.firstName    || '',
    data.lastName     || '',
    data.email        || '',
    data.phone        || '',
    data.ageLabel     || '',
    data.insurance    || '',
    'Form Fill',
    `LP - ${data.pageVariant || 'main'}`,
    data.utmSource    || '',
    data.utmCampaign  || '',
    data.gclid        || '',
    data.quizDiag     || '',
    data.quizWaitlist || '',
    data.pageVariant  || 'main',
    'Pending Review', '', 'Auto-added via LP form submit',
    data.contactId    || '',
  ];

  const encTab = encodeURIComponent(`'${tabName}'!A:W`);
  await fetch(
    `${base}/values/${encTab}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: auth, body: JSON.stringify({ values: [row], majorDimension: 'ROWS' }) },
  );
}
