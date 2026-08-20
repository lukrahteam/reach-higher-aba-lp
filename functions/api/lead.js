/**
 * Reach Higher ABA — CF Pages Function
 * Path: /api/lead
 *
 * Handles both full form submissions and progressive/partial captures.
 * Creates / upserts GHL contacts in OUR GHL first (for Lukrah tracking),
 * then forwards full-submit leads to the CLIENT's GHL as well.
 *
 * OUR GHL:
 *   Location: NTo0dHKMft9DfJU4PhwC (Reach Higher ABA — Lukrah)
 *   Pipeline: KiIFw3QQrGjqeYKdbTTg
 *   New Lead stage: ac11cac3-c337-41c2-bd92-3ac32447c9bb
 *
 * CLIENT GHL (Reach Higher ABA's own account):
 *   PIT: set in env as GHL_CLIENT_PIT
 *   No locationId needed — PIT is already scoped to their location.
 *   Only full submits are forwarded (not partial/progressive captures).
 *
 * Environment variables (CF Pages → Settings → Environment Variables):
 *   GHL_PIT        = pit-cd550eee-19f8-4939-bcf4-e051feda6317   (Lukrah's PIT)
 *   GHL_CLIENT_PIT = pit-0aa83ca4-fa83-496b-bbb0-480a2800b767   (Client's PIT)
 */

const GHL_BASE  = 'https://services.leadconnectorhq.com';
const LOC_ID    = 'NTo0dHKMft9DfJU4PhwC';
const PIPELINE  = 'KiIFw3QQrGjqeYKdbTTg';
const STAGE_NEW = 'ac11cac3-c337-41c2-bd92-3ac32447c9bb';

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

  // ── Headers for OUR GHL ──────────────────────────────────────────────────
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
    firstName:    firstName  || undefined,
    lastName:     lastName   || undefined,
    phone:        phone      || undefined,
    email:        email      || undefined,
    source,
    tags,
    gclId:        gclid      || undefined,
    utmSource:    utmSource  || undefined,
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

  // ── 3. Forward to CLIENT'S GHL — full submit only ────────────────────────
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
        firstName:    firstName  || undefined,
        lastName:     lastName   || undefined,
        phone:        phone      || undefined,
        email:        email      || undefined,
        source:       'Lukrah LP',
        tags:         ['lukrah-lp', 'google-ads'],
        gclId:        gclid      || undefined,
        utmSource:    utmSource  || undefined,
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
      // Non-fatal — our GHL already captured the lead
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

// ── helpers ──────────────────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
