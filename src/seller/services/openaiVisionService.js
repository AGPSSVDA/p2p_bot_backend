/**
 * OpenAI Vision service (seller Method 2)
 *
 * Classifies + extracts data from the ID images a buyer uploads in the Binance
 * order chat. One call handles ALL images at once and returns structured JSON:
 *   - which image is Aadhaar front / Aadhaar back / PAN / unknown
 *   - Aadhaar name (front only)
 *   - PAN number + PAN name
 *
 * Uses GPT-4o vision via a plain HTTPS POST (no npm dependency). Images are passed
 * as Binance CDN URLs (public), so we don't download/base64 them.
 *
 * Requires OPENAI_API_KEY in the environment.
 */

const axios = require('axios');
const https = require('https');
const logger = require('../../utils/logger');
const openaiUsage = require('./openaiUsageService');

const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
// 'high' reads small ID text better but costs ~4x tokens. On a low TPM tier,
// set OPENAI_VISION_DETAIL=low to fit more images per minute.
const IMAGE_DETAIL = process.env.OPENAI_VISION_DETAIL || 'high';

const SYSTEM_PROMPT = `You are an ID document classifier and data extractor for an Indian KYC flow.
You receive one or more images. For EACH image, determine its type and extract fields.

Types (use exactly one per image):
- "aadhaar_front": Aadhaar card side with the person's NAME, photo, DOB/gender and the 12-digit Aadhaar number.
- "aadhaar_back": Aadhaar card side with the ADDRESS (Aadhaar number may repeat, but NO name/photo).
- "pan": PAN card (the side showing the 10-char PAN like ABCDE1234F, the holder's NAME, father's name, DOB, photo).
- "unknown": anything else (selfie, payment screenshot, blurry/unreadable, not an ID).

Extraction rules:
- aadhaar_front: "name" = full name printed (English). Do NOT extract the Aadhaar number.
- aadhaar_back: name null.
- pan: "pan_number" = the 10-character PAN, and "name" = the holder's full name.
- Names must be the exact printed English text, uppercase, no titles.
- If a field is not clearly readable, set it to null. Never guess.

Respond with STRICT JSON only, no markdown, in this shape:
{
  "images": [
    { "index": 0, "type": "aadhaar_front", "name": "VIKRAM KUMAR", "pan_number": null },
    { "index": 1, "type": "aadhaar_back",  "name": null,           "pan_number": null },
    { "index": 2, "type": "pan",           "name": "VIKRAM KUMAR", "pan_number": "ABCDE1234F" }
  ]
}`;

/**
 * Classify + extract from a list of image URLs.
 * @param {string[]} imageUrls
 * @returns {Promise<{success:boolean, images?:Array, message?:string}>}
 *   images: [{ index, type, name, pan_number }]
 */
/**
 * Download an image and return a base64 data URL.
 * Binance serves chat images as `binary/octet-stream`, which OpenAI's URL
 * fetcher rejects — so we fetch the bytes ourselves and inline them as a
 * proper image/jpeg data URL.
 */
async function toDataUrl(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    httpsAgent: ipv4Agent,
    timeout: 20000,
    maxContentLength: 25 * 1024 * 1024,
  });
  let mime = res.headers['content-type'] || '';
  if (!mime.startsWith('image/')) mime = 'image/jpeg'; // Binance sends octet-stream
  const b64 = Buffer.from(res.data).toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function classifyAndExtract(imageUrls, orderNumber = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, message: 'OPENAI_API_KEY not set' };
  }
  if (!imageUrls || imageUrls.length === 0) {
    return { success: true, images: [] };
  }

  // Artificial credit gate (see classifyImage).
  if (await openaiUsage.isCreditExhausted()) {
    logger.warn('OpenAI token limit exceeded — refusing request (artificial credit gate)', { orderNumber });
    return { success: false, creditExhausted: true, message: 'OpenAI token limit exceeded' };
  }

  // Fetch each image and inline as base64 (Binance URLs aren't OpenAI-fetchable).
  let dataUrls;
  try {
    dataUrls = await Promise.all(imageUrls.map(toDataUrl));
  } catch (e) {
    logger.error('OpenAI vision: failed to download image(s)', { detail: e.message });
    return { success: false, message: `Could not download image: ${e.message}` };
  }

  // Build the user content: instruction + each image as an inlined data URL.
  const userContent = [
    {
      type: 'text',
      text: `Classify and extract from these ${dataUrls.length} image(s). ` +
        `Return one entry per image in the same order (index 0..${dataUrls.length - 1}).`,
    },
    ...dataUrls.map((url) => ({
      type: 'image_url',
      image_url: { url, detail: IMAGE_DETAIL },
    })),
  ];

  const payload = {
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  };

  try {
    // Retry on 429 (rate limit) using the API's suggested wait, up to 3 tries.
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await axios.post(OPENAI_URL, payload, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
          httpsAgent: ipv4Agent,
        });
        break;
      } catch (err) {
        const status = err.response?.status;
        if (status === 429 && attempt < 3) {
          // Honour Retry-After / the "try again in Xs" hint, default 20s.
          const retryAfter = Number(err.response?.headers?.['retry-after']) * 1000;
          const msg = err.response?.data?.error?.message || '';
          const m = msg.match(/try again in ([\d.]+)s/i);
          const waitMs = retryAfter || (m ? Math.ceil(parseFloat(m[1]) * 1000) : 20000);
          logger.warn(`OpenAI vision 429 — retrying in ${waitMs}ms (attempt ${attempt}/3)`);
          await new Promise((r) => setTimeout(r, waitMs + 500));
          continue;
        }
        throw err;
      }
    }

    // Record token usage + estimated cost for this request (never throws).
    await openaiUsage.logUsage({
      orderNumber,
      model: res.data?.model || MODEL,
      usage: res.data?.usage,
      purpose: 'document_verification',
    });

    const raw = res.data?.choices?.[0]?.message?.content;
    if (!raw) {
      return { success: false, message: 'Empty response from OpenAI' };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      logger.warn('OpenAI vision: could not parse JSON', { raw: String(raw).slice(0, 300) });
      return { success: false, message: 'Could not parse OpenAI response' };
    }

    const images = Array.isArray(parsed.images) ? parsed.images : [];

    // Normalise: uppercase names, clean PAN, ensure fields exist.
    const normalised = images.map((it, i) => ({
      index: typeof it.index === 'number' ? it.index : i,
      type: it.type || 'unknown',
      name: it.name ? String(it.name).toUpperCase().trim() : null,
      pan_number: it.pan_number ? String(it.pan_number).toUpperCase().replace(/\s+/g, '') : null,
    }));

    logger.info('OpenAI vision classified images', {
      count: normalised.length,
      types: normalised.map((n) => n.type),
    });

    return { success: true, images: normalised };
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data?.error?.message || error.message;
    logger.error('OpenAI vision call failed', { status, detail });
    return { success: false, message: detail };
  }
}

// Single-image prompt for the incremental flow. A buyer may put MORE THAN ONE
// document in one image (e.g. an e-Aadhaar PDF screenshot that shows the front
// card AND the back/address block, or a photo of Aadhaar front+back side by
// side). So we ask for a "documents" ARRAY of everything present in this one
// image — not a single type.
const SINGLE_PROMPT = `You are an ID document classifier and data extractor for an Indian KYC flow.
You receive ONE image. It may contain ONE OR MORE Indian ID documents (a single
image can show, for example, an Aadhaar front card AND the Aadhaar back/address
block together, as in an e-Aadhaar PDF screenshot).

Detect EVERY distinct document present in this image. For each, decide its type:
- "aadhaar_front": the Aadhaar side/section showing the person's NAME + photo + DOB/gender (and the 12-digit Aadhaar number).
- "aadhaar_back": the Aadhaar side/section showing the ADDRESS (Aadhaar number may repeat, but NO name/photo).
- "pan": a PAN card (10-char PAN like ABCDE1234F, holder's NAME, father's name, DOB, photo).

Extraction rules:
- aadhaar_front: "name" = full printed name (English). Do NOT extract the Aadhaar number.
- aadhaar_back: "name" = null.
- pan: "pan_number" = the 10-character PAN, "name" = holder's full name.
- Names: exact printed English text, uppercase, no titles. If unreadable, null. Never guess.
- If the image is NOT an Indian ID at all (selfie, payment screenshot, blurry/unreadable),
  return an empty "documents" array.

Respond with STRICT JSON only, no markdown:
{
  "documents": [
    { "type": "aadhaar_front", "name": "VIKRAM KUMAR", "pan_number": null },
    { "type": "aadhaar_back",  "name": null,           "pan_number": null }
  ]
}`;

/**
 * Classify + extract from a SINGLE image (the incremental Method 2 flow).
 *
 * Because one image can carry more than one document, this returns ALL documents
 * detected in the image. The caller advances verification for each.
 *
 * @param {string} imageUrl
 * @param {string|null} orderNumber
 * @returns {Promise<{success:boolean, documents?:Array<{type,name,pan_number}>, message?:string}>}
 */
async function classifyImage(imageUrl, orderNumber = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, message: 'OPENAI_API_KEY not set' };
  if (!imageUrl) return { success: true, documents: [] };

  // Artificial credit gate: if our tracked credit is exhausted, refuse the call
  // ("token limit exceeded") even if the real OpenAI account still has credit.
  if (await openaiUsage.isCreditExhausted()) {
    logger.warn('OpenAI token limit exceeded — refusing request (artificial credit gate)', { orderNumber });
    return { success: false, creditExhausted: true, message: 'OpenAI token limit exceeded' };
  }

  let dataUrl;
  try {
    dataUrl = await toDataUrl(imageUrl);
  } catch (e) {
    logger.error('OpenAI vision (single): failed to download image', { detail: e.message });
    return { success: false, message: `Could not download image: ${e.message}` };
  }

  const payload = {
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SINGLE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Detect and extract all Indian ID documents in this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: IMAGE_DETAIL } },
        ],
      },
    ],
  };

  try {
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await axios.post(OPENAI_URL, payload, {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 60000,
          httpsAgent: ipv4Agent,
        });
        break;
      } catch (err) {
        const status = err.response?.status;
        if (status === 429 && attempt < 3) {
          const retryAfter = Number(err.response?.headers?.['retry-after']) * 1000;
          const msg = err.response?.data?.error?.message || '';
          const m = msg.match(/try again in ([\d.]+)s/i);
          const waitMs = retryAfter || (m ? Math.ceil(parseFloat(m[1]) * 1000) : 20000);
          logger.warn(`OpenAI vision (single) 429 — retrying in ${waitMs}ms (attempt ${attempt}/3)`);
          await new Promise((r) => setTimeout(r, waitMs + 500));
          continue;
        }
        throw err;
      }
    }

    await openaiUsage.logUsage({
      orderNumber,
      model: res.data?.model || MODEL,
      usage: res.data?.usage,
      purpose: 'document_verification',
    });

    const raw = res.data?.choices?.[0]?.message?.content;
    if (!raw) return { success: false, message: 'Empty response from OpenAI' };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      logger.warn('OpenAI vision (single): could not parse JSON', { raw: String(raw).slice(0, 300) });
      return { success: false, message: 'Could not parse OpenAI response' };
    }

    const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
    const normalised = docs.map((d) => ({
      type: d.type || 'unknown',
      name: d.name ? String(d.name).toUpperCase().trim() : null,
      pan_number: d.pan_number ? String(d.pan_number).toUpperCase().replace(/\s+/g, '') : null,
    }));

    logger.info('OpenAI vision (single) classified', { types: normalised.map((n) => n.type) });
    return { success: true, documents: normalised };
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data?.error?.message || error.message;
    logger.error('OpenAI vision (single) call failed', { status, detail });
    return { success: false, message: detail };
  }
}

module.exports = { classifyAndExtract, classifyImage };
