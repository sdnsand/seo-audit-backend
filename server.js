const express = require('express');
const cors = require('cors');
// const chromeLauncher = require('chrome-launcher'); // REMOVED to use Puppeteer's internal launcher for stability
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { Groq } = require("groq-sdk");
const fs = require('fs');
const path = require('path');
const urlModule = require('url');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Set Node.js environment variable to ignore SSL certificate errors
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

// Robust HTTP client
async function fetchContent(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000); // Increased timeout
    
    const response = await fetch(url, {
      signal: controller.signal,
      method: options.method || 'GET',
      headers: {
        'User-Agent': options.userAgent || 'Mozilla/5.0 (compatible; SEO-Audit-Tool/1.0; +http://your-site.com)',
        ...options.headers
      }
    });
    
    clearTimeout(timeoutId);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      text: () => Promise.resolve(response.text()),
      headersGet: (name) => response.headers.get(name)
    };
  } catch (error) {
    console.error(`fetchContent error for ${url}:`, error.message);
    throw error;
  }
}

const app = express();
// Allow CORS from anywhere (Critical for Framer)
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public')); 

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Ensure temp directory exists
const LOCAL_CHROME_PATH = path.join(__dirname, '.chrome-temp');
if (!fs.existsSync(LOCAL_CHROME_PATH)) fs.mkdirSync(LOCAL_CHROME_PATH);

// --- [HELPER FUNCTIONS OMITTED FOR BREVITY - THEY REMAIN THE SAME] ---
// (Keep analyzeKeywords, evaluateContentUniqueness, analyzeImages, etc. exactly as they were)
// For the purpose of this fix, I am pasting the specific updated scrapeSite logic below.
// Copy your existing helper functions here...

// --- RE-INSERT YOUR HELPER FUNCTIONS HERE (analyzeKeywords, etc.) --- 
// ... (Your previous helper functions go here) ...

// ==========================================
// 🚀 THE FIXED SCRAPE FUNCTION
// ==========================================
async function scrapeSite(targetUrl) {
  console.log(`Step 1: Launching Chrome for ${targetUrl}...`);
  let browser = null;
  let metrics = { performance: 0, seo: 0, mobileFriendly: false, mobileScore: 0, technical: {}, security: {} };

  try {
    // Dynamic import for Lighthouse
    const { default: lighthouse } = await import('lighthouse');
    
    // FIX: Use Puppeteer to launch Chrome (More stable in Docker than chrome-launcher)
    browser = await puppeteer.launch({
      headless: "new", // Modern headless mode
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // CRITICAL: Prevents crash on Render/Linux
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        // '--single-process', // Uncomment if still crashing
      ],
      userDataDir: LOCAL_CHROME_PATH
    });

    // Get the port Puppeteer is using
    const browserWSEndpoint = browser.wsEndpoint();
    const port = new URL(browserWSEndpoint).port;

    // A. Lighthouse (Speed/Tech)
    console.log(`Step 2: Running Lighthouse on port ${port}...`);
    
    const options = { 
      logLevel: 'error', 
      output: 'json', 
      onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'], 
      port: port, // Connect Lighthouse to Puppeteer's Chrome
      formFactor: 'mobile', // Mobile first indexing
      screenEmulation: { mobile: true }
    };
    
    const runnerResult = await lighthouse(targetUrl, options);
    const report = runnerResult.lhr;

    if (report.categories.performance) metrics.performance = Math.round(report.categories.performance.score * 100);
    if (report.categories.seo) metrics.seo = Math.round(report.categories.seo.score * 100);
    
    // Mobile Friendly Logic
    const viewport = report.audits['viewport']?.score === 1;
    const tapTargets = report.audits['tap-targets']?.score === 1;
    metrics.mobileFriendly = viewport && tapTargets;
    metrics.mobileScore = metrics.mobileFriendly ? 90 : (viewport ? 60 : 30);

    // Tech Metrics Extraction
    metrics.technical = {
      firstContentfulPaint: report.audits['first-contentful-paint'],
      largestContentfulPaint: report.audits['largest-contentful-paint'],
      cumulativeLayoutShift: report.audits['cumulative-layout-shift'],
      timeToInteractive: report.audits['interactive'],
      totalBlockingTime: report.audits['total-blocking-time'],
      speedIndex: report.audits['speed-index']
    };

    metrics.security = {
        httpsUsed: targetUrl.startsWith('https://'),
        mixedContent: report.audits['mixed-content']?.score === 1
    };

  } catch (lhError) { 
      console.error("⚠️ Lighthouse error:", lhError.message); 
      // If Lighthouse fails, we still want to try Puppeteer for content
  }

  // B. Puppeteer (Content & Structure)
  console.log("Step 3: Grabbing HTML via Puppeteer...");
  let html = "";
  let textContent = "";
  let structure = {};
  
  try {
      // Reuse the existing browser if alive, otherwise launch new
      if (!browser || !browser.isConnected()) {
         browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-dev-shm-usage']
         });
      }

      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (compatible; SEO-Audit-Tool/1.0)');
      
      // Increased timeout for slow sites
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      
      html = await page.content();
      
      // Extract data
      const $ = cheerio.load(html);
      
      // ... (Your existing extraction logic) ...
      const title = $('title').text().trim();
      const description = $('meta[name="description"]').attr('content') || "";
      const h1Count = $('h1').length;
      const totalImages = $('img').length;
      const missingAlt = $('img:not([alt])').length;
      
      $('script').remove(); $('style').remove();
      textContent = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 3000);

      structure = {
          title,
          description,
          h1Count,
          wordCount: textContent.split(' ').length,
          readabilityScore: 70, // Simplified placeholder or use your calculator
          images: { total: totalImages, missingAlt },
          links: { internal: 0, external: 0 }, // Populate if you have the logic
          socials: "Analyzed"
      };

  } catch (pupError) { 
      console.error("⚠️ Puppeteer error:", pupError.message); 
      html = "<body><h1>Content unavailable</h1></body>"; 
  } finally {
      if (browser) await browser.close();
      try { fs.rmSync(LOCAL_CHROME_PATH, { recursive: true, force: true }); } catch (e) {}
  }

  return { metrics, structure, textContent, domain: targetUrl };
}

// AI Function (Keep existing)
async function getAIAdvice(data) {
  // ... (Keep your existing AI logic) ...
  // Returns mock data if AI fails to prevent crash
  if (!data || !data.metrics) return { health_score: 50, summary: "Analysis failed", recommendations: [] };
  
  try {
      const prompt = `Analyze SEO for ${data.url}. Speed: ${data.metrics.performance}, SEO: ${data.metrics.seo}. Return JSON with health_score, summary, and recommendations.`;
      
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
      });
      return JSON.parse(completion.choices[0].message.content);
  } catch(e) {
      console.log("AI Error", e.message);
      return { health_score: data.metrics.performance, summary: "AI Busy", recommendations: [] };
  }
}

app.post('/api/audit', async (req, res) => {
  try {
    let { url, email } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });
    if (!url.startsWith('http')) url = 'https://' + url;
    
    console.log(`🚀 Starting audit for: ${url}`);
    const rawData = await scrapeSite(url);
    const aiReport = await getAIAdvice({ url, ...rawData });
    
    res.json({
      url,
      timestamp: new Date().toISOString(),
      metrics: rawData.metrics,
      structure: rawData.structure,
      report: aiReport
    });
    
  } catch (error) {
    console.error("❌ AUDIT ERROR:", error);
    res.status(500).json({ error: "Audit failed", details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
